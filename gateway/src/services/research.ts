/**
 * AuthorClaw Research Gate
 * Constrained internet access for research only
 * Domain allowlist prevents access to banking, social login, admin panels
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { AuditLog } from '../security/audit.js';

export class ResearchGate {
  private allowlistPath: string;
  private audit: AuditLog;
  private allowedDomains: Set<string> = new Set();
  private requestCount = 0;
  private maxRequestsPerHour = 60;
  private requestTimestamps: number[] = [];

  constructor(allowlistPath: string, audit: AuditLog) {
    this.allowlistPath = allowlistPath;
    this.audit = audit;
  }

  async initialize(): Promise<void> {
    if (existsSync(this.allowlistPath)) {
      const raw = await readFile(this.allowlistPath, 'utf-8');
      const data = JSON.parse(raw);
      this.allowedDomains = new Set(data.domains || []);
    }
  }

  getAllowedDomainCount(): number {
    return this.allowedDomains.size;
  }

  getAllowedDomains(): string[] {
    return Array.from(this.allowedDomains);
  }

  isAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace(/^www\./, '');

      // Check exact match and wildcard
      if (this.allowedDomains.has(domain)) return true;

      // Check parent domain (e.g., *.google.com)
      const parts = domain.split('.');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(i).join('.');
        if (this.allowedDomains.has('*.' + parent)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  checkRateLimit(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 3600000);
    if (this.requestTimestamps.length >= this.maxRequestsPerHour) return false;
    this.requestTimestamps.push(now);
    return true;
  }

  async fetch(url: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    if (!this.isAllowed(url)) {
      await this.audit.log('research', 'blocked_domain', { url });
      return { ok: false, error: `Domain not on research allowlist: ${url}` };
    }

    if (!this.checkRateLimit()) {
      return { ok: false, error: 'Research rate limit exceeded. Try again later.' };
    }

    try {
      const response = await globalThis.fetch(url, {
        headers: { 'User-Agent': 'AuthorClaw-Research/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      await this.audit.log('research', 'fetch_success', { url, status: response.status });
      return { ok: true, text: text.substring(0, 50000) }; // Cap response size
    } catch (error) {
      await this.audit.log('research', 'fetch_error', { url, error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  /**
   * Fetch a URL and extract clean text content from the HTML.
   * Strips scripts, styles, nav, headers, footers, then HTML tags.
   */
  async fetchAndExtract(url: string): Promise<{ ok: boolean; text?: string; title?: string; error?: string }> {
    const result = await this.fetch(url);
    if (!result.ok || !result.text) return result;

    const extracted = this.extractText(result.text);
    return { ok: true, text: extracted.text.substring(0, 30000), title: extracted.title };
  }

  /**
   * Search the web using DuckDuckGo Lite (no API key needed).
   * Results are filtered through the domain allowlist.
   */
  async search(query: string, maxResults: number = 5): Promise<{
    results: Array<{ title: string; url: string; snippet: string }>;
    blocked: Array<{ url: string; reason: string }>;
  }> {
    if (!this.checkRateLimit()) {
      return { results: [], blocked: [{ url: '', reason: 'Rate limit exceeded' }] };
    }

    await this.audit.log('research', 'search', { query, maxResults });

    const allResults: Array<{ title: string; url: string; snippet: string }> = [];
    const blocked: Array<{ url: string; reason: string }> = [];

    try {
      const encodedQuery = encodeURIComponent(query);
      const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;

      const response = await globalThis.fetch(searchUrl, {
        headers: {
          'User-Agent': 'AuthorClaw-Research/1.0',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });
      const html = await response.text();

      // Parse DuckDuckGo Lite results
      // Results are in table rows with class="result-link" and "result-snippet"
      const linkPattern = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      const snippetPattern = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

      const links: Array<{ url: string; title: string }> = [];
      let linkMatch;
      while ((linkMatch = linkPattern.exec(html)) !== null) {
        links.push({ url: linkMatch[1], title: linkMatch[2].trim() });
      }

      const snippets: string[] = [];
      let snippetMatch;
      while ((snippetMatch = snippetPattern.exec(html)) !== null) {
        snippets.push(snippetMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      // If DuckDuckGo Lite format changed, try a simpler pattern
      if (links.length === 0) {
        const altPattern = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{5,})<\/a>/gi;
        let altMatch;
        const seenUrls = new Set<string>();
        while ((altMatch = altPattern.exec(html)) !== null) {
          const url = altMatch[1];
          if (!url.includes('duckduckgo.com') && !seenUrls.has(url)) {
            seenUrls.add(url);
            links.push({ url, title: altMatch[2].trim() });
          }
        }
      }

      // Filter through allowlist
      for (let i = 0; i < links.length && allResults.length < maxResults; i++) {
        const link = links[i];
        if (this.isAllowed(link.url)) {
          allResults.push({
            title: link.title,
            url: link.url,
            snippet: snippets[i] || '',
          });
        } else {
          blocked.push({ url: link.url, reason: 'Domain not on allowlist' });
        }
      }

      await this.audit.log('research', 'search_complete', {
        query,
        found: links.length,
        allowed: allResults.length,
        blocked: blocked.length,
      });
    } catch (error) {
      await this.audit.log('research', 'search_error', { query, error: String(error) });
    }

    return { results: allResults, blocked };
  }

  /**
   * Extract readable text content from HTML.
   * Lightweight — no external dependencies.
   */
  private extractText(html: string): { text: string; title: string } {
    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

    let text = html;

    // Remove unwanted sections entirely
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // Convert block elements to newlines
    text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|section|article)[^>]*>/gi, '\n');

    // Strip remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode common HTML entities
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#039;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');

    // Collapse whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n\n');
    text = text.trim();

    return { text, title };
  }
}
