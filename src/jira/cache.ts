import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Disk cache of graph sessions: open instantly from the last state, then catch up with Jira.
// A cache, not a store: anything missing, old, corrupt or written by another format means a cold load.

/** Bump when the snapshot shape changes; older files are ignored (and pruned). */
export const CACHE_VERSION = 1;

export interface CacheOptions {
  dir: string;
  /** Snapshots older than this are not used. */
  maxAgeMs: number;
  /** Total size cap; least recently used files go first. */
  maxBytes: number;
}

interface Envelope<T> {
  version: number;
  /** Hash of everything that decides what was fetched (fields, options): a mismatch means a cold load. */
  fingerprint: string;
  savedAt: number;
  data: T;
}

export function fingerprint(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export class GraphCache {
  constructor(private readonly opts: CacheOptions) {}

  private file(key: string): string {
    return join(this.opts.dir, `graph-${fingerprint(key)}.json`);
  }

  /** The snapshot for `key`, or undefined when absent, stale, from another format/fingerprint or unreadable. */
  async load<T>(key: string, fp: string, now = Date.now()): Promise<{ data: T; savedAt: number } | undefined> {
    try {
      const env = JSON.parse(await readFile(this.file(key), 'utf8')) as Envelope<T>;
      if (env.version !== CACHE_VERSION || env.fingerprint !== fp) return undefined;
      if (!(now - env.savedAt < this.opts.maxAgeMs)) return undefined;
      return { data: env.data, savedAt: env.savedAt };
    } catch {
      return undefined; // missing or corrupt: a cold load rebuilds it
    }
  }

  /** Atomic write (temp file + rename), then keep the directory within the size cap. */
  async save<T>(key: string, fp: string, data: T, now = Date.now()): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    const target = this.file(key);
    const tmp = `${target}.${process.pid}.${now}.tmp`;
    const env: Envelope<T> = { version: CACHE_VERSION, fingerprint: fp, savedAt: now, data };
    await writeFile(tmp, JSON.stringify(env), 'utf8');
    await rename(tmp, target);
    await this.prune(now);
  }

  async delete(key: string): Promise<void> {
    await unlink(this.file(key)).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await rm(this.opts.dir, { recursive: true, force: true });
  }

  /** Drop leftovers and expired files, then least recently written until under the cap. */
  async prune(now = Date.now()): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch {
      return;
    }
    const files: { path: string; size: number; mtime: number }[] = [];
    for (const n of names) {
      const path = join(this.opts.dir, n);
      try {
        const st = await stat(path);
        const stale = now - st.mtimeMs > this.opts.maxAgeMs;
        const orphanTmp = n.endsWith('.tmp') && now - st.mtimeMs > 60_000;
        if (stale || orphanTmp) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        if (n.endsWith('.json')) files.push({ path, size: st.size, mtime: st.mtimeMs });
      } catch {
        // raced with another window; ignore
      }
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.opts.maxBytes) break;
      await unlink(f.path).catch(() => undefined);
      total -= f.size;
    }
  }
}
