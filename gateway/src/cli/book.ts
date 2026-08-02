/**
 * `npm run book -- <command>` — manage per-book workspaces (ALP-1596).
 *
 * Switching the active book is restart-scoped: services are boot-time
 * singletons (see workspace-routing.ts), so `use` only updates the
 * `.active-book` pointer file. Restart the gateway for it to take effect.
 */

import { resolveInstallRootDir, loadInstallDotenv } from '../services/install-root.js';
import {
  resolveWorkspaceRoot,
  looksLikeLegacyFlatWorkspace,
  readActiveBookPointer,
  writeActiveBookPointer,
  listBooks,
  scaffoldBookWorkspace,
  migrateLegacyWorkspace,
  slugifyBookName,
  isValidBookSlug,
} from '../services/workspace-routing.js';
import { join } from 'path';
import { existsSync } from 'fs';

const ROOT_DIR = resolveInstallRootDir(import.meta.url, 3);
loadInstallDotenv(ROOT_DIR);

const ROOT = resolveWorkspaceRoot(process.env, join(ROOT_DIR, 'workspace'));

function usage(): void {
  console.log(`Usage: npm run book -- <command> [args]

Commands:
  list                    List book workspaces under the root and show which is active
  create <name>           Scaffold a new, isolated book workspace ("<name>" is slugified)
  use <slug>               Set the active book (restart the gateway to apply)
  migrate-legacy [slug]    One-time move of an existing flat workspace into <root>/<slug>/
                            (defaults slug to "default"), then sets it active

Root: ${ROOT}`);
}

async function cmdList(): Promise<void> {
  const legacy = looksLikeLegacyFlatWorkspace(ROOT);
  const pointer = readActiveBookPointer(ROOT);
  const books = await listBooks(ROOT);

  if (legacy && !pointer) {
    console.log(`Legacy flat workspace in place at ${ROOT} (no active-book selector set — this IS the workspace).`);
  }
  if (books.length === 0) {
    console.log('No per-book workspaces found under the root.');
    return;
  }
  console.log(`Books under ${ROOT}:`);
  for (const book of books) {
    console.log(`  ${book.active ? '*' : ' '} ${book.slug}`);
  }
}

async function cmdCreate(rawName: string | undefined): Promise<void> {
  if (!rawName) {
    console.error('Usage: npm run book -- create <name>');
    process.exitCode = 1;
    return;
  }
  const slug = slugifyBookName(rawName);
  const dir = await scaffoldBookWorkspace(ROOT, slug, ROOT_DIR);
  console.log(`Created book workspace: ${dir}`);
  console.log(`Run \`npm run book -- use ${slug}\` and restart the gateway to switch to it.`);
}

function cmdUse(slug: string | undefined): void {
  if (!slug || !isValidBookSlug(slug)) {
    console.error('Usage: npm run book -- use <slug>');
    process.exitCode = 1;
    return;
  }
  const bookDir = join(ROOT, slug);
  if (!existsSync(bookDir)) {
    console.error(`No book workspace found at ${bookDir}. Run \`npm run book -- create ${slug}\` or \`list\` first.`);
    process.exitCode = 1;
    return;
  }
  writeActiveBookPointer(ROOT, slug);
  console.log(`Active book set to '${slug}'. Restart the gateway for this to take effect.`);
}

async function cmdMigrateLegacy(rawSlug: string | undefined): Promise<void> {
  const slug = rawSlug ? slugifyBookName(rawSlug) : 'default';
  const dir = await migrateLegacyWorkspace(ROOT, slug);
  console.log(`Migrated legacy flat workspace into: ${dir}`);
  console.log(`Active book set to '${slug}'. Restart the gateway for this to take effect.`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  try {
    switch (command) {
      case 'list':
        await cmdList();
        break;
      case 'create':
        await cmdCreate(arg);
        break;
      case 'use':
        cmdUse(arg);
        break;
      case 'migrate-legacy':
        await cmdMigrateLegacy(arg);
        break;
      default:
        usage();
        if (command) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`book: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

main();
