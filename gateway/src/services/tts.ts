/**
 * AuthorClaw TTS Service
 * Text-to-speech using Microsoft Edge TTS (free, no API key, neural voices)
 *
 * Uses the node-edge-tts package to access Microsoft's Edge Read Aloud engine.
 * 300+ voices, 90+ languages, high-quality neural synthesis.
 * Outputs MP3 directly — no ffmpeg or binary installation needed.
 */

import { mkdir, readdir, stat, readFile, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

export interface TTSResult {
  success: boolean;
  file?: string;
  filename?: string;
  format?: string;
  size?: number;
  duration?: number; // estimated seconds
  error?: string;
}

export interface TTSVoice {
  id: string;        // e.g. 'en-US-AriaNeural'
  name: string;      // e.g. 'Aria'
  language: string;   // e.g. 'en-US'
  gender: string;     // 'Female' or 'Male'
  description: string; // Author-friendly description
}

export interface VoicePreset {
  id: string;
  voice: string;
  description: string;
  gender: string;
}

export class TTSService {
  private audioDir: string;
  private configDir: string;
  private defaultVoice = 'en-US-AriaNeural';
  private defaultPreset = 'narrator_female';
  private configuredVoice: string | null = null;

  // Author-focused voice presets (from AuthorScribe Audio)
  static readonly VOICE_PRESETS: Record<string, VoicePreset> = {
    narrator_female: {
      id: 'narrator_female',
      voice: 'en-US-AriaNeural',
      description: 'Versatile female — clear, expressive, works for most genres',
      gender: 'Female',
    },
    narrator_male: {
      id: 'narrator_male',
      voice: 'en-US-GuyNeural',
      description: 'Warm male — great for literary fiction, thriller narration',
      gender: 'Male',
    },
    narrator_deep: {
      id: 'narrator_deep',
      voice: 'en-US-ChristopherNeural',
      description: 'Deep, authoritative male — epic fantasy, sci-fi, nonfiction',
      gender: 'Male',
    },
    narrator_warm: {
      id: 'narrator_warm',
      voice: 'en-US-JennyNeural',
      description: 'Warm, approachable female — romance, memoir',
      gender: 'Female',
    },
    british_male: {
      id: 'british_male',
      voice: 'en-GB-RyanNeural',
      description: 'British male — literary fiction, period pieces, cozy mysteries',
      gender: 'Male',
    },
    british_female: {
      id: 'british_female',
      voice: 'en-GB-SoniaNeural',
      description: 'British female — elegant, clear, literary',
      gender: 'Female',
    },
    storyteller: {
      id: 'storyteller',
      voice: 'en-US-AndrewNeural',
      description: 'Engaging male storyteller — adventure, YA, middle grade',
      gender: 'Male',
    },
    dramatic: {
      id: 'dramatic',
      voice: 'en-US-RogerNeural',
      description: 'Dramatic male — action, thriller, horror',
      gender: 'Male',
    },
  };

  constructor(workspaceDir: string) {
    this.audioDir = join(workspaceDir, 'audio');
    this.configDir = join(workspaceDir, '.config');
  }

  async initialize(): Promise<void> {
    await mkdir(this.audioDir, { recursive: true });
    await mkdir(this.configDir, { recursive: true });
    await this.loadVoiceConfig();
  }

  // ── Voice Config Persistence ──

  private async loadVoiceConfig(): Promise<void> {
    const configPath = join(this.configDir, 'tts.json');
    try {
      const raw = await readFile(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.voice && typeof config.voice === 'string') {
        this.configuredVoice = config.voice;
      }
    } catch { /* no config yet — use default */ }
  }

  async setVoice(voice: string): Promise<void> {
    this.configuredVoice = voice;
    const configPath = join(this.configDir, 'tts.json');
    await writeFile(configPath, JSON.stringify({ voice }, null, 2));
  }

  getActiveVoice(): string {
    return this.configuredVoice || this.defaultVoice;
  }

  /** Edge TTS is always available (only needs internet) */
  isAvailable(): boolean {
    return true;
  }

  // ── Voice Resolution ──

  /**
   * Resolve a voice input to a Microsoft voice ID.
   * Accepts: preset name ('narrator_deep'), voice ID ('en-US-DavisNeural'), or null (use default).
   */
  resolveVoice(input?: string): string {
    if (!input) return this.getActiveVoice();
    // Check if it's a preset name
    const preset = TTSService.VOICE_PRESETS[input.toLowerCase()];
    if (preset) return preset.voice;
    // Otherwise treat as a raw voice ID
    return input;
  }

  // ── Audio Generation ──

  /**
   * Generate audio from text using Microsoft Edge TTS.
   * Returns the file path of the generated MP3.
   */
  async generate(text: string, options: {
    voice?: string;
    rate?: string;   // e.g. '+10%', '-20%', '+0%'
    pitch?: string;  // e.g. '+5Hz', '-10Hz', '+0Hz'
    volume?: string; // e.g. '+0%', '-50%'
  } = {}): Promise<TTSResult> {
    // Lazy import to avoid issues if package isn't installed
    const { EdgeTTS } = await import('node-edge-tts');

    const voice = this.resolveVoice(options.voice);
    const id = randomBytes(6).toString('hex');
    const filename = `tts-${id}.mp3`;
    const outputFile = join(this.audioDir, filename);

    try {
      // Limit text length (Edge TTS handles long text well but let's be sensible)
      const trimmedText = text.substring(0, 50000);

      const tts = new EdgeTTS({
        voice,
        lang: voice.split('-').slice(0, 2).join('-'), // e.g. 'en-US' from 'en-US-AriaNeural'
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        ...(options.rate && { rate: options.rate }),
        ...(options.pitch && { pitch: options.pitch }),
        ...(options.volume && { volume: options.volume }),
      });

      await tts.ttsPromise(trimmedText, outputFile);

      const fileStats = await stat(outputFile);

      // Estimate duration: ~150 words/minute, average word ~5 chars
      const wordCount = trimmedText.split(/\s+/).length;
      const estimatedDuration = Math.round((wordCount / 150) * 60);

      return {
        success: true,
        file: outputFile,
        filename,
        format: 'mp3',
        size: fileStats.size,
        duration: estimatedDuration,
      };
    } catch (error) {
      return {
        success: false,
        error: `TTS generation failed: ${String(error)}. Make sure you have internet access.`,
      };
    }
  }

  // ── Voice Catalog ──

  /**
   * List available voice presets (author-friendly).
   */
  listPresets(): VoicePreset[] {
    return Object.values(TTSService.VOICE_PRESETS);
  }

  /**
   * Get the raw audio file buffer (for Telegram voice messages, etc.)
   */
  async getAudioBuffer(filePath: string): Promise<Buffer | null> {
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  // ── Cleanup ──

  /**
   * Clean up old audio files (older than 24 hours).
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    try {
      const files = await readdir(this.audioDir);
      for (const file of files) {
        if (!String(file).startsWith('tts-')) continue;
        const filePath = join(this.audioDir, String(file));
        try {
          const stats = await stat(filePath);
          if (stats.mtimeMs < cutoff) {
            await unlink(filePath);
            cleaned++;
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist yet */ }

    return cleaned;
  }

  getAudioDir(): string {
    return this.audioDir;
  }
}
