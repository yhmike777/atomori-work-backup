import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { seedRecords } from './catalog.js';

export class RecordStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.pending = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = structuredClone(seedRecords);
      await this.save();
    }
    for (const key of ['findings', 'rechecks', 'events']) {
      if (!Array.isArray(this.data[key])) throw new Error(`Invalid record store: ${key}`);
    }
  }

  snapshot() { return structuredClone(this.data); }

  async change(fn) {
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.data);
      const result = fn(next);
      await this.save(next);
      this.data = next;
      return structuredClone(result);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async save(data = this.data) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
    await rename(temporary, this.filePath);
  }
}
