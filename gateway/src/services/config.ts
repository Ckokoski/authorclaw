/**
 * AuthorAgent Configuration Service
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export class ConfigService {
  private configDir: string;
  private config: Record<string, any> = {};
  private userOverrides: Record<string, any> = {};

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  async load(): Promise<void> {
    const defaultPath = join(this.configDir, 'default.json');
    if (existsSync(defaultPath)) {
      const raw = await readFile(defaultPath, 'utf-8');
      this.config = JSON.parse(raw);
    }

    // Merge user overrides
    const userPath = join(this.configDir, 'user.json');
    if (existsSync(userPath)) {
      const raw = await readFile(userPath, 'utf-8');
      this.userOverrides = JSON.parse(raw);
      this.config = this.deepMerge(this.config, this.userOverrides);
    }

    // Environment variable overrides
    if (process.env.AUTHORCLAW_PORT) this.set('server.port', parseInt(process.env.AUTHORCLAW_PORT));
    // Bind address. Defaults to 127.0.0.1 (default.json) because the gateway has
    // no auth of its own — never widen this without an authenticating front door
    // in front of it. Containers must set 0.0.0.0 so the published port works at
    // all; deploy/nas/ pairs that with a basic-auth nginx proxy.
    if (process.env.AUTHORCLAW_HOST) this.set('server.host', process.env.AUTHORCLAW_HOST);
    if (process.env.AUTHORCLAW_PRESET) this.set('security.permissionPreset', process.env.AUTHORCLAW_PRESET);
  }

  get(path: string, defaultValue?: any): any {
    const parts = path.split('.');
    let current = this.config;
    for (const part of parts) {
      if (current?.[part] === undefined) return defaultValue;
      current = current[part];
    }
    return current ?? defaultValue;
  }

  set(path: string, value: any): void {
    const parts = path.split('.');
    let current = this.config;
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = current[parts[i]];
      if (existing === undefined || existing === null) {
        current[parts[i]] = {};
      } else if (typeof existing !== 'object' || Array.isArray(existing)) {
        // Refuse to drill into a primitive / array — prevents silent data loss
        // when someone calls set('server.port', 3000) but server is a string.
        throw new Error(
          `Cannot set '${path}': '${parts.slice(0, i + 1).join('.')}' is a ${typeof existing}, not an object.`
        );
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  /** Set a value and persist it to config/user.json so it survives restarts. */
  async setAndPersist(path: string, value: any): Promise<void> {
    this.set(path, value);

    // Also update userOverrides
    const parts = path.split('.');
    let current = this.userOverrides;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;

    // Write to disk
    const userPath = join(this.configDir, 'user.json');
    await writeFile(userPath, JSON.stringify(this.userOverrides, null, 2), 'utf-8');
  }

  private deepMerge(target: any, source: any): any {
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        output[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }
}
