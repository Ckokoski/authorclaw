/**
 * AuthorClaw Author OS Integration Service
 * Bridges AuthorClaw with the Author OS tool suite:
 *   - Author Workflow Engine (JSON writing templates)
 *   - Book Bible Engine (story planning & world-building)
 *   - Manuscript Autopsy (manuscript analysis)
 *   - AI Author Library (writing prompts & blueprints)
 *   - Creator Asset Suite (marketing & asset creation)
 *
 * Mount points:
 *   Docker:  /app/author-os
 *   VM:      ~/author-os
 *
 * Directory mapping (tool key -> accepted folder names):
 *   workflow-engine:     "workflow-engine" or "Author Workflow Engine"
 *   book-bible:          "book-bible" or "Book Bible Engine"
 *   manuscript-autopsy:  "manuscript-autopsy" or "Manuscript Autopsy"
 *   ai-author-library:   "ai-author-library" or "AI Author Library"
 *   creator-asset-suite: "creator-asset-suite" or "Creator Asset Suite"
 *   format-factory:      "format-factory" or "Format Factory Pro"
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';

/**
 * Maps each tool key to possible directory names inside Author OS.
 * The copy-to-vm script uses short names (workflow-engine, book-bible, etc.)
 * while the original Author OS folders use full names.
 * We check both so it works regardless of how files were copied.
 */
const TOOL_DIRS: Record<string, string[]> = {
  'workflow-engine':     ['workflow-engine', 'Author Workflow Engine'],
  'book-bible':          ['book-bible', 'Book Bible Engine'],
  'manuscript-autopsy':  ['manuscript-autopsy', 'Manuscript Autopsy'],
  'ai-author-library':   ['ai-author-library', 'AI Author Library'],
  'creator-asset-suite': ['creator-asset-suite', 'Creator Asset Suite'],
  'format-factory':      ['format-factory', 'Format Factory Pro'],
};

export class AuthorOSService {
  private basePath: string;
  private available: Map<string, boolean> = new Map();
  /** Resolved directory name for each tool (whichever variant was found) */
  private resolvedDirs: Map<string, string> = new Map();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  // ── Lifecycle ────────────────────────────────────────────

  /**
   * Probe the filesystem to see which Author OS tools are present.
   * Checks all known directory name variants for each tool.
   * Safe to call even when the mount is missing entirely.
   */
  async initialize(): Promise<void> {
    for (const [key, dirNames] of Object.entries(TOOL_DIRS)) {
      let found = false;
      for (const dirName of dirNames) {
        const toolPath = join(this.basePath, dirName);
        if (existsSync(toolPath)) {
          this.resolvedDirs.set(key, dirName);
          found = true;
          break;
        }
      }
      this.available.set(key, found);
    }
  }

  /** Return the keys of every tool whose directory exists */
  getAvailableTools(): string[] {
    return Array.from(this.available.entries())
      .filter(([, present]) => present)
      .map(([key]) => key);
  }

  /** Status summary for the dashboard / API */
  getStatus(): { tool: string; available: boolean }[] {
    return Array.from(this.available.entries()).map(([tool, available]) => ({
      tool,
      available,
    }));
  }

  /**
   * Auto-generate "synthetic" skill metadata from each available Author OS tool.
   * Returns SkillLoader-compatible records the SkillLoader can register without
   * requiring the user to write SKILL.md files for every Author OS tool.
   *
   * The triggers are derived from the tool name + the names of any prominent
   * subfolders / files. Each synthetic skill includes a description that
   * teaches the AI how to USE the tool from the live Author OS folder so it
   * isn't just a dead trigger word.
   */
  async generateSyntheticSkills(): Promise<Array<{
    name: string;
    description: string;
    triggers: string[];
    permissions: string[];
    syntheticFromAuthorOS: true;
  }>> {
    const skills: Array<{
      name: string;
      description: string;
      triggers: string[];
      permissions: string[];
      syntheticFromAuthorOS: true;
    }> = [];

    const TOOL_TEMPLATES: Record<string, {
      name: string;
      description: string;
      triggers: string[];
    }> = {
      'workflow-engine': {
        name: 'author-os-workflow',
        description: 'Run an Author OS Workflow Engine template — JSON-defined writing workflows from Author OS',
        triggers: ['run workflow', 'workflow template', 'author os workflow', 'load template', 'workflow engine'],
      },
      'book-bible': {
        name: 'author-os-book-bible',
        description: 'Use the Author OS Book Bible Engine for character / world / timeline tracking',
        triggers: ['book bible', 'world bible', 'character bible', 'author os bible', 'series bible'],
      },
      'manuscript-autopsy': {
        name: 'author-os-autopsy',
        description: 'Run Author OS Manuscript Autopsy — pacing + structure + craft analysis on a manuscript',
        triggers: ['manuscript autopsy', 'autopsy', 'analyze my manuscript', 'pacing analysis', 'structure analysis'],
      },
      'ai-author-library': {
        name: 'author-os-library',
        description: 'Browse the Author OS AI Author Library for prompts, voice markers, and writing references',
        triggers: ['author library', 'writing prompts', 'voice markers', 'prompt library', 'ai author library'],
      },
      'creator-asset-suite': {
        name: 'author-os-marketing',
        description: 'Generate marketing assets via the Author OS Creator Asset Suite — blurbs, ads, social posts',
        triggers: ['creator asset', 'marketing assets', 'asset suite', 'author os marketing', 'launch assets'],
      },
      'format-factory': {
        name: 'author-os-format',
        description: 'Format manuscripts for KDP / IngramSpark using Format Factory Pro from Author OS',
        triggers: ['format factory', 'format for kdp', 'format manuscript', 'kdp formatting', 'ingramspark format'],
      },
    };

    for (const [toolKey, template] of Object.entries(TOOL_TEMPLATES)) {
      if (!this.isAvailable(toolKey)) continue;

      let extraTriggers: string[] = [];
      // Inspect the tool's top-level files for additional trigger words.
      try {
        const dir = this.toolDir(toolKey);
        const entries = await readdir(dir);
        // Look for distinctive filenames — README.md, primary template names, etc.
        for (const entry of entries.slice(0, 20)) {
          const lower = entry.toLowerCase();
          if (lower.endsWith('.md') || lower.endsWith('.json') || lower.endsWith('.py')) {
            const stem = lower.replace(/\.(md|json|py)$/, '').replace(/[-_]+/g, ' ').trim();
            if (stem.length > 4 && stem.length < 30 && !template.triggers.includes(stem)) {
              extraTriggers.push(stem);
            }
          }
        }
      } catch { /* directory unreadable — skip extras */ }

      skills.push({
        name: template.name,
        description: template.description,
        triggers: [...template.triggers, ...extraTriggers.slice(0, 5)],
        permissions: ['file_read', 'memory_read'],
        syntheticFromAuthorOS: true,
      });
    }

    return skills;
  }

  // ── Workflow Engine ──────────────────────────────────────

  /**
   * Read a named workflow template (JSON) from the Workflow Engine.
   * Searches recursively for a file whose name matches `templateName`
   * (with or without .json extension).
   */
  async getWorkflowTemplate(templateName: string): Promise<string | null> {
    if (!this.isAvailable('workflow-engine')) return null;

    const dir = this.toolDir('workflow-engine');
    const target = templateName.endsWith('.json') ? templateName : `${templateName}.json`;

    try {
      const match = await this.findFile(dir, target);
      if (match) {
        return await readFile(match, 'utf-8');
      }

      // Fallback: look for any JSON file containing the template name
      const allJson = await this.findFilesByExtension(dir, '.json');
      for (const file of allJson) {
        const basename = file.split(/[\\/]/).pop()?.toLowerCase() ?? '';
        if (basename.includes(templateName.toLowerCase())) {
          return await readFile(file, 'utf-8');
        }
      }
    } catch {
      // Directory unreadable or gone — treat as unavailable
    }

    return null;
  }

  /**
   * List all available workflow template names.
   */
  async listWorkflowTemplates(): Promise<string[]> {
    if (!this.isAvailable('workflow-engine')) return [];

    try {
      const files = await this.findFilesByExtension(this.toolDir('workflow-engine'), '.json');
      return files.map((f) => f.split(/[\\/]/).pop() ?? f);
    } catch {
      return [];
    }
  }

  // ── Book Bible Engine ────────────────────────────────────

  /**
   * Read the Book Bible template/schema.
   * Returns the first JSON or Markdown template found.
   */
  async getBookBibleTemplate(): Promise<string | null> {
    if (!this.isAvailable('book-bible')) return null;

    const dir = this.toolDir('book-bible');

    try {
      // Look for a primary template file
      for (const name of ['template.json', 'bible-template.json', 'book-bible.json', 'template.md', 'README.md']) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) {
          return await readFile(candidate, 'utf-8');
        }
      }

      // Fallback: return the first JSON found
      const jsonFiles = await this.findFilesByExtension(dir, '.json');
      if (jsonFiles.length > 0) {
        return await readFile(jsonFiles[0], 'utf-8');
      }

      // Fallback: return the first Markdown found
      const mdFiles = await this.findFilesByExtension(dir, '.md');
      if (mdFiles.length > 0) {
        return await readFile(mdFiles[0], 'utf-8');
      }
    } catch {
      // Not readable
    }

    return null;
  }

  // ── AI Author Library ────────────────────────────────────

  /**
   * Retrieve writing prompts / blueprints from the AI Author Library.
   * Optionally filter by genre (matches against file names and content).
   */
  async getWritingPrompts(genre?: string): Promise<string[]> {
    if (!this.isAvailable('ai-author-library')) return [];

    const dir = this.toolDir('ai-author-library');
    const prompts: string[] = [];

    try {
      const files = await this.collectReadableFiles(dir);

      for (const file of files) {
        const ext = file.split('.').pop()?.toLowerCase();
        if (!ext || !['json', 'md', 'txt', 'yaml', 'yml'].includes(ext)) continue;

        const content = await this.safeReadFile(file);
        if (!content) continue;

        // If a genre filter is provided, skip non-matching files
        if (genre) {
          const lower = (file + content).toLowerCase();
          if (!lower.includes(genre.toLowerCase())) continue;
        }

        prompts.push(content);
      }
    } catch {
      // Not readable
    }

    return prompts;
  }

  // ── Style Analysis (Style Clone Pro) ─────────────────────

  /**
   * Read style analysis configuration / markers.
   * Style Clone Pro is documented as having 47 voice markers.
   * This looks inside the AI Author Library and Manuscript Autopsy
   * for style-related config files.
   */
  async getStyleMarkers(): Promise<any | null> {
    // Check multiple likely locations for style marker config
    const candidates: string[] = [];

    if (this.isAvailable('ai-author-library')) {
      const libDir = this.toolDir('ai-author-library');
      candidates.push(
        join(libDir, 'style-markers.json'),
        join(libDir, 'voice-markers.json'),
        join(libDir, 'style-clone.json'),
        join(libDir, 'Style Clone Pro', 'markers.json'),
        join(libDir, 'Style Clone Pro', 'style-markers.json'),
      );
    }

    if (this.isAvailable('manuscript-autopsy')) {
      const maDir = this.toolDir('manuscript-autopsy');
      candidates.push(
        join(maDir, 'style-markers.json'),
        join(maDir, 'voice-markers.json'),
        join(maDir, 'config.json'),
      );
    }

    // Also check top-level Author OS for a standalone Style Clone Pro dir
    const styleCloneDir = join(this.basePath, 'Style Clone Pro');
    if (existsSync(styleCloneDir)) {
      candidates.push(
        join(styleCloneDir, 'markers.json'),
        join(styleCloneDir, 'style-markers.json'),
        join(styleCloneDir, 'config.json'),
      );
    }

    for (const path of candidates) {
      const content = await this.safeReadFile(path);
      if (content) {
        try {
          return JSON.parse(content);
        } catch {
          // Not JSON — return raw string
          return content;
        }
      }
    }

    // Deep search: find any file containing "style" or "marker" in its name
    for (const toolKey of ['ai-author-library', 'manuscript-autopsy']) {
      if (!this.isAvailable(toolKey)) continue;
      try {
        const files = await this.collectReadableFiles(this.toolDir(toolKey));
        for (const file of files) {
          const basename = file.split(/[\\/]/).pop()?.toLowerCase() ?? '';
          if (basename.includes('style') || basename.includes('marker') || basename.includes('voice')) {
            const content = await this.safeReadFile(file);
            if (content) {
              try { return JSON.parse(content); } catch { return content; }
            }
          }
        }
      } catch {
        // Skip
      }
    }

    return null;
  }

  // ── Creator Asset Suite / Format Factory ─────────────────

  /**
   * List available export formats from the Creator Asset Suite.
   * Looks for template files, Python scripts, or config that
   * describe supported output formats.
   */
  async getExportFormats(): Promise<string[]> {
    if (!this.isAvailable('creator-asset-suite')) {
      // Also check for a standalone Format Factory Pro directory
      const ffDir = join(this.basePath, 'Format Factory Pro');
      if (existsSync(ffDir)) {
        return this.scanExportFormats(ffDir);
      }
      return [];
    }

    const dir = this.toolDir('creator-asset-suite');
    return this.scanExportFormats(dir);
  }

  private async scanExportFormats(dir: string): Promise<string[]> {
    const formats: string[] = [];

    try {
      const files = await this.collectReadableFiles(dir);

      for (const file of files) {
        const basename = file.split(/[\\/]/).pop()?.toLowerCase() ?? '';
        const ext = basename.split('.').pop() ?? '';

        // Python export scripts
        if (ext === 'py' && (basename.includes('format') || basename.includes('export'))) {
          formats.push(basename.replace('.py', ''));
        }

        // Template files
        if (['docx', 'epub', 'pdf', 'html', 'rtf', 'odt'].includes(ext)) {
          formats.push(ext.toUpperCase());
        }

        // Config files that list formats
        if (basename === 'formats.json' || basename === 'config.json') {
          const content = await this.safeReadFile(file);
          if (content) {
            try {
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed.formats)) {
                formats.push(...parsed.formats);
              } else if (Array.isArray(parsed)) {
                formats.push(...parsed.map(String));
              }
            } catch {
              // Not parseable
            }
          }
        }
      }
    } catch {
      // Not readable
    }

    // Deduplicate
    return [...new Set(formats)];
  }

  // ── Manuscript Autopsy ───────────────────────────────────

  /**
   * Read the Manuscript Autopsy configuration or analysis schema.
   */
  async getAutopsyConfig(): Promise<any | null> {
    if (!this.isAvailable('manuscript-autopsy')) return null;

    const dir = this.toolDir('manuscript-autopsy');
    for (const name of ['config.json', 'schema.json', 'autopsy.json', 'README.md']) {
      const content = await this.safeReadFile(join(dir, name));
      if (content) {
        try { return JSON.parse(content); } catch { return content; }
      }
    }

    return null;
  }

  // ── Helpers ──────────────────────────────────────────────

  private isAvailable(tool: string): boolean {
    return this.available.get(tool) === true;
  }

  private toolDir(tool: string): string {
    // Use the resolved (actually found) directory name first
    const resolved = this.resolvedDirs.get(tool);
    if (resolved) return join(this.basePath, resolved);
    // Fallback to the first known name variant
    const dirNames = TOOL_DIRS[tool];
    if (!dirNames) throw new Error(`Unknown Author OS tool: ${tool}`);
    return join(this.basePath, dirNames[0]);
  }

  /** Safely read a file, returning null on any error */
  private async safeReadFile(filePath: string): Promise<string | null> {
    try {
      if (!existsSync(filePath)) return null;
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Recursively find a file by exact name (case-insensitive) */
  private async findFile(dir: string, targetName: string): Promise<string | null> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await this.findFile(fullPath, targetName);
          if (found) return found;
        } else if (entry.name.toLowerCase() === targetName.toLowerCase()) {
          return fullPath;
        }
      }
    } catch {
      // Permission denied or removed
    }
    return null;
  }

  /** Recursively collect all files with a given extension */
  private async findFilesByExtension(dir: string, ext: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...await this.findFilesByExtension(fullPath, ext));
        } else if (entry.name.toLowerCase().endsWith(ext.toLowerCase())) {
          results.push(fullPath);
        }
      }
    } catch {
      // Permission denied or directory removed
    }
    return results;
  }

  /** Recursively collect all readable files (up to 500 to prevent runaway) */
  private async collectReadableFiles(dir: string, maxFiles = 500): Promise<string[]> {
    const results: string[] = [];
    await this.walkDir(dir, results, maxFiles);
    return results;
  }

  private async walkDir(dir: string, results: string[], maxFiles: number): Promise<void> {
    if (results.length >= maxFiles) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) return;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.walkDir(fullPath, results, maxFiles);
        } else {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  // ── Tool Execution ──────────────────────────────────────

  /** Get the base path for security checks */
  getBasePath(): string {
    return this.basePath;
  }

  /**
   * Execute a Python tool with sandboxed output.
   * Cross-platform: tries python3 first, falls back to python.
   */
  async executePythonTool(
    toolKey: string,
    scriptName: string,
    args: string[],
    outputDir: string,
    timeoutMs: number = 120000
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
    if (!this.isAvailable(toolKey)) {
      return { stdout: '', stderr: '', exitCode: null, error: `Tool not available: ${toolKey}` };
    }

    const dir = this.toolDir(toolKey);
    const scriptPath = join(dir, scriptName);

    if (!existsSync(scriptPath)) {
      return { stdout: '', stderr: '', exitCode: null, error: `Script not found: ${scriptName} in ${toolKey}` };
    }

    if (!outputDir) {
      return { stdout: '', stderr: '', exitCode: null, error: 'Output directory is required' };
    }

    const tryPython = (cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> => {
      return new Promise((resolve) => {
        const proc = spawn(cmd, [scriptPath, ...args], {
          cwd: dir,
          timeout: timeoutMs,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
        proc.on('error', (err) => resolve({ stdout, stderr, exitCode: null, error: err.message }));
      });
    };

    // Try python3 first (Linux/macOS), fall back to python (Windows)
    const result = await tryPython('python3');
    if (result.error?.includes('ENOENT')) {
      return tryPython('python');
    }
    return result;
  }

  /**
   * Run Format Factory Pro to export a manuscript.
   */
  async runFormatFactory(
    inputFile: string,
    title: string,
    author: string,
    formats: string[],
    outputDir: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
    const args = [inputFile, '-t', title, '-a', author, '-o', outputDir];
    for (const fmt of formats) {
      if (fmt === 'all') args.push('--all');
      else args.push(`--${fmt}`);
    }

    if (this.isAvailable('format-factory')) {
      return this.executePythonTool('format-factory', 'format_factory_pro.py', args, outputDir);
    }

    // Format Factory Pro may live inside Creator Asset Suite
    if (this.isAvailable('creator-asset-suite')) {
      const csDir = this.toolDir('creator-asset-suite');
      const ffScript = join(csDir, 'Format Factory Pro', 'format_factory_pro.py');
      if (existsSync(ffScript)) {
        const tryCmd = (cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> => {
          return new Promise((resolve) => {
            const proc = spawn(cmd, [ffScript, ...args], {
              cwd: join(csDir, 'Format Factory Pro'),
              timeout: 120000,
            });
            let stdout = '', stderr = '';
            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
            proc.on('error', (err) => resolve({ stdout, stderr, exitCode: null, error: err.message }));
          });
        };
        const result = await tryCmd('python3');
        if (result.error?.includes('ENOENT')) return tryCmd('python');
        return result;
      }
    }

    return { stdout: '', stderr: '', exitCode: null, error: 'Format Factory Pro not found in Author OS' };
  }
}
