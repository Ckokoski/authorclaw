/**
 * AuthorClaw Heartbeat Service
 * Writing session tracker, project monitor, deadline alerts, milestone celebrations
 *
 * v2.1: Autonomous mode — wakes up on schedule, checks for active projects,
 * and executes the next step automatically. The writing agent that works
 * while you sleep (but respects your quiet hours).
 */

import { MemoryService } from './memory.js';

interface WritingSession {
  startTime: Date;
  lastActivity: Date;
  wordCountStart: number;
  wordCountCurrent: number;
  channel: string;
}

interface HeartbeatConfig {
  intervalMinutes: number;
  dailyWordGoal: number;
  enableReminders: boolean;
  quietHoursStart: number; // 24h format
  quietHoursEnd: number;
  // Autonomous mode
  autonomousEnabled: boolean;
  autonomousIntervalMinutes: number; // How often to check for work (default: 30)
  maxAutonomousStepsPerWake: number; // Safety limit per wake cycle (default: 5)
}

/**
 * Callback type for autonomous project execution.
 * Injected by the gateway so heartbeat can trigger project steps
 * without importing the project engine or AI router directly.
 */
export type AutonomousRunFunc = (projectId: string) => Promise<
  { completed: string; response: string; wordCount: number; nextStep?: string } | { error: string }
>;

export type AutonomousProjectListFunc = () => Array<{
  id: string;
  title: string;
  status: string;
  progress: string;
  progressNum: number;
  stepsRemaining: number;
  type: string;
}>;

export type StatusBroadcastFunc = (message: string) => void;

export type AnalyzeProjectFunc = (projectId: string) => Promise<{
  insights: string[];
  strengths: string[];
  weaknesses: string[];
} | null>;

export type CreateFollowUpProjectFunc = (
  originalProjectId: string,
  originalTitle: string,
  originalType: string
) => Promise<string | null>;

/**
 * Callback for idle tasks — runs when the autonomous agent wakes up
 * but has no active projects. Should do something genuinely helpful
 * and additive (never destructive). Uses free-tier AI only.
 */
export type IdleTaskFunc = () => Promise<string | null>;

export interface AgentJournalEntry {
  timestamp: string;
  type: 'wake' | 'step' | 'decision' | 'difficulty' | 'plan' | 'improve' | 'idle';
  message: string;
  metadata?: Record<string, any>;
}

export class HeartbeatService {
  private config: HeartbeatConfig;
  private memory: MemoryService;
  private timer: ReturnType<typeof setInterval> | null = null;
  private autonomousTimer: ReturnType<typeof setInterval> | null = null;
  private currentSession: WritingSession | null = null;
  private todayWords = 0;
  private streak = 0;
  private lastWritingDate: string | null = null;

  // Autonomous mode
  private autonomousRunStep: AutonomousRunFunc | null = null;
  private autonomousListProjects: AutonomousProjectListFunc | null = null;
  private statusBroadcast: StatusBroadcastFunc | null = null;
  private analyzeProject: AnalyzeProjectFunc | null = null;
  private createFollowUpProject: CreateFollowUpProjectFunc | null = null;
  private idleTask: IdleTaskFunc | null = null;
  private lastIdleTaskDate: string | null = null; // Only run idle tasks once per day
  private autonomousPaused = false;
  private isRunning = false; // Prevent overlapping autonomous runs
  private journal: AgentJournalEntry[] = [];
  private totalAutonomousSteps = 0;
  private totalAutonomousWords = 0;

  // Reminder tracking
  private lastReminderSent = 0; // timestamp
  private reminderMilestones: Set<number> = new Set(); // word goal % milestones already sent today
  private lastReminderDate: string | null = null; // for resetting milestones on new day

  constructor(config: Partial<HeartbeatConfig>, memory: MemoryService) {
    this.config = {
      intervalMinutes: config.intervalMinutes ?? 15,
      dailyWordGoal: config.dailyWordGoal ?? 1000,
      enableReminders: config.enableReminders ?? true,
      quietHoursStart: config.quietHoursStart ?? 22,
      quietHoursEnd: config.quietHoursEnd ?? 7,
      autonomousEnabled: config.autonomousEnabled ?? false,
      autonomousIntervalMinutes: config.autonomousIntervalMinutes ?? 30,
      maxAutonomousStepsPerWake: config.maxAutonomousStepsPerWake ?? 5,
    };
    this.memory = memory;
  }

  /**
   * Wire up autonomous capabilities. Called after project engine and AI are ready.
   */
  setAutonomous(
    runStep: AutonomousRunFunc,
    listProjects: AutonomousProjectListFunc,
    broadcast: StatusBroadcastFunc,
    analyzeProject?: AnalyzeProjectFunc,
    createFollowUp?: CreateFollowUpProjectFunc,
    idleTask?: IdleTaskFunc
  ): void {
    this.autonomousRunStep = runStep;
    this.autonomousListProjects = listProjects;
    this.statusBroadcast = broadcast;
    this.analyzeProject = analyzeProject || null;
    this.createFollowUpProject = createFollowUp || null;
    this.idleTask = idleTask || null;
  }

  start(): void {
    // Standard heartbeat timer (session tracking, streaks)
    this.timer = setInterval(
      () => this.tick(),
      this.config.intervalMinutes * 60 * 1000
    );

    // Autonomous timer (goal execution) — separate interval
    if (this.config.autonomousEnabled && this.autonomousRunStep) {
      this.startAutonomous();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopAutonomous();
  }

  // ── Autonomous Mode Control ──

  /**
   * Enable autonomous mode at runtime (e.g., from dashboard or Telegram)
   */
  enableAutonomous(): void {
    this.config.autonomousEnabled = true;
    this.autonomousPaused = false;
    if (!this.autonomousTimer && this.autonomousRunStep) {
      this.startAutonomous();
    }
    this.logAutonomous('Autonomous mode ENABLED', 'wake');
    this.broadcast('🤖 Autonomous mode enabled — I\'ll check for projects every ' +
      this.config.autonomousIntervalMinutes + ' minutes');
  }

  /**
   * Disable autonomous mode
   */
  disableAutonomous(): void {
    this.config.autonomousEnabled = false;
    this.stopAutonomous();
    this.logAutonomous('Autonomous mode DISABLED', 'wake');
    this.broadcast('⏹ Autonomous mode disabled — I\'ll wait for your instructions');
  }

  /**
   * Pause autonomous mode temporarily (resumes on next enableAutonomous call)
   */
  pauseAutonomous(): void {
    this.autonomousPaused = true;
    this.logAutonomous('Autonomous mode PAUSED', 'idle');
    this.broadcast('⏸ Autonomous mode paused');
  }

  /**
   * Resume autonomous mode after pause
   */
  resumeAutonomous(): void {
    this.autonomousPaused = false;
    this.logAutonomous('Autonomous mode RESUMED', 'wake');
    this.broadcast('▶️ Autonomous mode resumed');
  }

  /**
   * Check if autonomous mode is active and not paused
   */
  isAutonomousActive(): boolean {
    return this.config.autonomousEnabled && !this.autonomousPaused;
  }

  /**
   * Get autonomous mode status for dashboard/API
   */
  getAutonomousStatus(): {
    enabled: boolean;
    paused: boolean;
    running: boolean;
    intervalMinutes: number;
    maxStepsPerWake: number;
    quietHoursStart: number;
    quietHoursEnd: number;
    totalStepsExecuted: number;
    totalWordsGenerated: number;
    recentLog: AgentJournalEntry[];
  } {
    return {
      enabled: this.config.autonomousEnabled,
      paused: this.autonomousPaused,
      running: this.isRunning,
      intervalMinutes: this.config.autonomousIntervalMinutes,
      maxStepsPerWake: this.config.maxAutonomousStepsPerWake,
      quietHoursStart: this.config.quietHoursStart,
      quietHoursEnd: this.config.quietHoursEnd,
      totalStepsExecuted: this.totalAutonomousSteps,
      totalWordsGenerated: Math.max(this.totalAutonomousWords, this.todayWords),
      recentLog: this.journal.slice(-20),
    };
  }

  /**
   * Get the full agent journal (last 200 entries)
   */
  getJournal(): AgentJournalEntry[] {
    return this.journal.slice(-200);
  }

  /**
   * Update autonomous configuration at runtime
   */
  updateAutonomousConfig(updates: {
    intervalMinutes?: number;
    maxStepsPerWake?: number;
    quietHoursStart?: number;
    quietHoursEnd?: number;
  }): void {
    if (updates.intervalMinutes !== undefined) {
      this.config.autonomousIntervalMinutes = updates.intervalMinutes;
    }
    if (updates.maxStepsPerWake !== undefined) {
      this.config.maxAutonomousStepsPerWake = updates.maxStepsPerWake;
    }
    if (updates.quietHoursStart !== undefined) {
      this.config.quietHoursStart = updates.quietHoursStart;
    }
    if (updates.quietHoursEnd !== undefined) {
      this.config.quietHoursEnd = updates.quietHoursEnd;
    }

    // Restart autonomous timer with new interval
    if (this.config.autonomousEnabled && this.autonomousRunStep) {
      this.stopAutonomous();
      this.startAutonomous();
    }

    this.logAutonomous(`Config updated: interval=${this.config.autonomousIntervalMinutes}min, ` +
      `maxSteps=${this.config.maxAutonomousStepsPerWake}, ` +
      `quiet=${this.config.quietHoursStart}:00-${this.config.quietHoursEnd}:00`, 'plan');
  }

  // ── Standard Heartbeat ──

  private async tick(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    // Respect quiet hours
    if (this.isQuietHours(hour)) {
      return;
    }

    // Check for day rollover
    const today = now.toISOString().split('T')[0];
    if (this.lastWritingDate && this.lastWritingDate !== today) {
      // Check if yesterday had words (streak tracking)
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (this.lastWritingDate === yesterdayStr && this.todayWords > 0) {
        this.streak++;
      } else if (this.lastWritingDate !== yesterdayStr) {
        this.streak = 0;
      }

      this.todayWords = 0;
    }

    // Check reminders (if enabled)
    if (this.config.enableReminders) {
      this.checkReminders(now, today);
    }
  }

  /**
   * Reminder engine — sends motivational nudges via WebSocket + Telegram.
   * Max 1 reminder per hour to avoid spam.
   *
   * Three reminder types:
   *  1. No writing today → gentle nudge after 10am
   *  2. Word goal milestones → encouragement at 25%, 50%, 75%, 90%
   *  3. Streak at risk → warning after 6pm if last writing was yesterday
   */
  private checkReminders(now: Date, today: string): void {
    // Rate limit: max 1 reminder per hour
    if (now.getTime() - this.lastReminderSent < 60 * 60 * 1000) return;

    const hour = now.getHours();

    // Reset milestones on new day
    if (this.lastReminderDate !== today) {
      this.reminderMilestones.clear();
      this.lastReminderDate = today;
    }

    // ── Type 1: No writing today (after 10am) ──
    if (hour >= 10 && this.todayWords === 0 && !this.reminderMilestones.has(0)) {
      this.reminderMilestones.add(0);
      this.sendReminder(
        `📝 You haven't written anything today yet. ` +
        `Your daily goal is ${this.config.dailyWordGoal.toLocaleString()} words — ` +
        `even 100 words keeps the momentum going!`
      );
      return;
    }

    // ── Type 2: Word goal milestones ──
    if (this.todayWords > 0 && this.config.dailyWordGoal > 0) {
      const percent = Math.round((this.todayWords / this.config.dailyWordGoal) * 100);
      const milestones = [25, 50, 75, 90, 100];

      for (const milestone of milestones) {
        if (percent >= milestone && !this.reminderMilestones.has(milestone)) {
          this.reminderMilestones.add(milestone);
          const messages: Record<number, string> = {
            25: `🌱 25% of your daily goal — nice start! ${this.todayWords.toLocaleString()}/${this.config.dailyWordGoal.toLocaleString()} words`,
            50: `🔥 Halfway there! ${this.todayWords.toLocaleString()}/${this.config.dailyWordGoal.toLocaleString()} words — keep pushing!`,
            75: `💪 75% done! Only ${(this.config.dailyWordGoal - this.todayWords).toLocaleString()} words to go!`,
            90: `🏁 Almost there! 90% of your daily goal — you've got this!`,
            100: `🎉 Daily goal CRUSHED! ${this.todayWords.toLocaleString()} words today!` +
              (this.streak > 0 ? ` 🔥 ${this.streak}-day streak!` : ''),
          };
          this.sendReminder(messages[milestone]);
          return; // One reminder at a time
        }
      }
    }

    // ── Type 3: Streak at risk (after 6pm) ──
    if (hour >= 18 && this.streak > 0 && this.todayWords === 0 && !this.reminderMilestones.has(-1)) {
      this.reminderMilestones.add(-1); // -1 = streak warning sent
      this.sendReminder(
        `⚠️ Your ${this.streak}-day writing streak is at risk! ` +
        `Write something before midnight to keep it alive.`
      );
      return;
    }
  }

  /**
   * Send a reminder via the broadcast channel (WebSocket + Telegram)
   */
  private sendReminder(message: string): void {
    this.lastReminderSent = Date.now();
    this.broadcast(`💓 ${message}`);
    this.logAutonomous(`Reminder: ${message}`, 'idle');
  }

  // ── Autonomous Wake Cycle ──

  private startAutonomous(): void {
    if (this.autonomousTimer) return; // Already running

    // Run first check after a short delay (let the system fully boot)
    setTimeout(() => {
      if (this.config.autonomousEnabled) {
        this.autonomousWake();
      }
    }, 60_000); // 1 minute after start

    this.autonomousTimer = setInterval(
      () => this.autonomousWake(),
      this.config.autonomousIntervalMinutes * 60 * 1000
    );
  }

  private stopAutonomous(): void {
    if (this.autonomousTimer) {
      clearInterval(this.autonomousTimer);
      this.autonomousTimer = null;
    }
  }

  /**
   * The autonomous wake cycle with priority-based project selection.
   * Runs on schedule, scores projects by priority, and executes steps.
   */
  private async autonomousWake(): Promise<void> {
    // Guard: don't run if disabled, paused, in quiet hours, or already running
    if (!this.config.autonomousEnabled) return;
    if (this.autonomousPaused) return;
    if (this.isQuietHours(new Date().getHours())) return;
    if (this.isRunning) return;
    if (!this.autonomousRunStep || !this.autonomousListProjects) return;

    this.isRunning = true;
    this.logAutonomous('Waking up — checking for work...', 'wake');

    try {
      const projects = this.autonomousListProjects();

      // Score and sort projects by priority
      const scored = projects
        .filter(p => (p.status === 'active' || p.status === 'pending') && p.stepsRemaining > 0)
        .map(p => ({
          ...p,
          score: this.scoreProject(p),
        }))
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) {
        // No active projects — run an idle task if available (max once per day)
        const today = new Date().toISOString().split('T')[0];
        if (this.idleTask && this.lastIdleTaskDate !== today) {
          this.logAutonomous('No projects — running helpful idle task...', 'idle');
          try {
            const result = await this.idleTask();
            if (result) {
              this.lastIdleTaskDate = today;
              this.logAutonomous(`Idle task completed: ${result.substring(0, 100)}`, 'idle');
              this.broadcast(`💡 ${result}`);
            }
          } catch (err) {
            this.logAutonomous(`Idle task failed: ${err}`, 'difficulty');
          }
        } else {
          this.logAutonomous('No projects need work — idle', 'idle');
        }
        this.isRunning = false;
        return;
      }

      // Pick highest-priority project
      const targetProject = scored[0];
      this.logAutonomous(
        `Selected "${targetProject.title}" (score: ${targetProject.score}, ${targetProject.progress}, ${targetProject.stepsRemaining} remaining)`,
        'decision',
        { projectId: targetProject.id, score: targetProject.score, alternatives: scored.length - 1 }
      );
      this.broadcast(`⏰ Autonomous wake — working on: "${targetProject.title}"`);

      // Execute up to maxStepsPerWake steps
      let stepsThisWake = 0;
      let wordsThisWake = 0;

      for (let i = 0; i < this.config.maxAutonomousStepsPerWake; i++) {
        if (this.autonomousPaused) {
          this.logAutonomous(`Paused mid-cycle after ${stepsThisWake} steps`, 'idle');
          this.broadcast(`⏸ Paused mid-cycle after ${stepsThisWake} steps`);
          break;
        }

        if (this.isQuietHours(new Date().getHours())) {
          this.logAutonomous(`Entering quiet hours — stopping after ${stepsThisWake} steps`, 'idle');
          this.broadcast(`🌙 Entering quiet hours — stopping after ${stepsThisWake} steps`);
          break;
        }

        const result = await this.autonomousRunStep(targetProject.id);

        if ('error' in result) {
          this.logAutonomous(`Step failed: ${result.error}`, 'difficulty', { projectId: targetProject.id });
          this.broadcast(`❌ Autonomous step failed: ${result.error}`);
          break;
        }

        stepsThisWake++;
        wordsThisWake += result.wordCount || 0;
        this.totalAutonomousSteps++;
        this.totalAutonomousWords += result.wordCount || 0;

        this.logAutonomous(
          `Completed: "${result.completed}" (~${result.wordCount.toLocaleString()} words)`,
          'step',
          { projectId: targetProject.id, step: result.completed, wordCount: result.wordCount }
        );

        if (!result.nextStep) {
          this.logAutonomous(`Project "${targetProject.title}" COMPLETE!`, 'step', {
            projectId: targetProject.id,
            totalSteps: stepsThisWake,
            totalWords: wordsThisWake,
          });
          this.broadcast(
            `🎉 Project "${targetProject.title}" complete!\n` +
            `📊 This wake: ${stepsThisWake} steps, ~${wordsThisWake.toLocaleString()} words\n` +
            `📁 Files saved to workspace/projects/`
          );

          // Trigger self-improvement analysis
          await this.selfImprove(targetProject.id, targetProject.title);

          // Auto-create follow-up project for novel pipelines
          if (targetProject.type === 'novel-pipeline' && this.createFollowUpProject) {
            try {
              const followUpId = await this.createFollowUpProject(
                targetProject.id, targetProject.title, targetProject.type
              );
              if (followUpId) {
                this.logAutonomous(
                  `Follow-up project created for "${targetProject.title}"`,
                  'plan',
                  { originalProjectId: targetProject.id, followUpId }
                );
                this.broadcast(`📝 Follow-up project created: Polish & Publish for "${targetProject.title}"`);
              }
            } catch (err) {
              this.logAutonomous(`Follow-up creation failed: ${err}`, 'difficulty');
            }
          }

          break;
        }

        await this.sleep(3000);
      }

      if (stepsThisWake > 0) {
        const summary = `Wake cycle done: ${stepsThisWake} steps, ~${wordsThisWake.toLocaleString()} words`;
        this.logAutonomous(summary, 'wake', { steps: stepsThisWake, words: wordsThisWake });
        if (stepsThisWake >= this.config.maxAutonomousStepsPerWake) {
          this.broadcast(
            `📊 ${summary}\n⏰ Next wake in ${this.config.autonomousIntervalMinutes} minutes`
          );
        }
      }

    } catch (error) {
      this.logAutonomous(`Error during autonomous wake: ${error}`, 'difficulty');
      console.error('Autonomous wake error:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Score a project for priority-based selection.
   * Higher score = picked first.
   */
  private scoreProject(project: { status: string; progressNum: number; type: string; stepsRemaining: number }): number {
    let score = 0;
    // Active projects get strong priority
    if (project.status === 'active') score += 100;
    // Closer to finish = higher priority (finish what you started)
    if (project.progressNum > 50) score += 20;
    if (project.progressNum > 75) score += 15;
    // Novel pipelines get slight boost (long-running, should be prioritized)
    if (project.type === 'novel-pipeline') score += 10;
    // Fewer steps remaining = closer to done
    if (project.stepsRemaining <= 3) score += 10;
    return score;
  }

  /**
   * Self-improvement: After a project completes, analyze the outputs
   * and store actionable insights for future writing.
   */
  private async selfImprove(projectId: string, projectTitle: string): Promise<void> {
    if (!this.analyzeProject) return;

    this.logAutonomous(`Running self-improvement analysis for "${projectTitle}"...`, 'improve', { projectId });

    try {
      const analysis = await this.analyzeProject(projectId);
      if (!analysis) {
        this.logAutonomous('Self-improvement: no analysis returned', 'improve');
        return;
      }

      this.logAutonomous(
        `Self-improvement complete for "${projectTitle}": ${analysis.insights.length} insights, ` +
        `${analysis.strengths.length} strengths, ${analysis.weaknesses.length} weaknesses`,
        'improve',
        { projectId, insights: analysis.insights.length }
      );

      this.broadcast(
        `🧠 Self-improvement analysis for "${projectTitle}":\n` +
        `  Insights: ${analysis.insights.length}\n` +
        `  Strengths: ${analysis.strengths.length}\n` +
        `  Weaknesses: ${analysis.weaknesses.length}`
      );
    } catch (err) {
      this.logAutonomous(`Self-improvement failed: ${err}`, 'difficulty', { projectId });
    }
  }

  // ── Helpers ──

  private isQuietHours(hour: number): boolean {
    if (this.config.quietHoursStart > this.config.quietHoursEnd) {
      // Quiet hours span midnight (e.g., 22-7)
      return hour >= this.config.quietHoursStart || hour < this.config.quietHoursEnd;
    }
    // Quiet hours within same day (e.g., 1-6)
    return hour >= this.config.quietHoursStart && hour < this.config.quietHoursEnd;
  }

  private logAutonomous(message: string, type: AgentJournalEntry['type'] = 'wake', metadata?: Record<string, any>): void {
    const entry: AgentJournalEntry = { timestamp: new Date().toISOString(), type, message, metadata };
    this.journal.push(entry);
    // Keep last 200 entries
    if (this.journal.length > 200) {
      this.journal = this.journal.slice(-200);
    }
    console.log(`  💓 ${message}`);
  }

  private broadcast(message: string): void {
    if (this.statusBroadcast) {
      this.statusBroadcast(message);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Activity Tracking (unchanged) ──

  recordActivity(type: string, data: Record<string, any>): void {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    this.lastWritingDate = today;

    if (type === 'word_count_update') {
      this.todayWords = data.todayTotal || this.todayWords;
    }
  }

  startSession(channel: string, startingWordCount: number): void {
    this.currentSession = {
      startTime: new Date(),
      lastActivity: new Date(),
      wordCountStart: startingWordCount,
      wordCountCurrent: startingWordCount,
      channel,
    };
  }

  updateSession(wordCount: number): void {
    if (this.currentSession) {
      this.currentSession.wordCountCurrent = wordCount;
      this.currentSession.lastActivity = new Date();
    }
  }

  endSession(): { duration: number; wordsWritten: number } | null {
    if (!this.currentSession) return null;

    const duration = Date.now() - this.currentSession.startTime.getTime();
    const wordsWritten = this.currentSession.wordCountCurrent - this.currentSession.wordCountStart;
    this.currentSession = null;

    return { duration, wordsWritten };
  }

  /** Add words to today's count (called by goal engine after each step) */
  addWords(count: number): void {
    if (count > 0) {
      this.todayWords += count;
      this.lastWritingDate = new Date().toISOString().split('T')[0];
    }
  }

  /** Structured stats for dashboard Morning Briefing */
  getStats(): {
    todayWords: number; dailyWordGoal: number; streak: number;
    goalPercent: number; enableReminders: boolean;
    sessionMinutes: number; sessionWords: number;
  } {
    const goalPercent = Math.min(100, Math.round((this.todayWords / this.config.dailyWordGoal) * 100));
    let sessionMinutes = 0, sessionWords = 0;
    if (this.currentSession) {
      sessionMinutes = Math.round((Date.now() - this.currentSession.startTime.getTime()) / 60000);
      sessionWords = this.currentSession.wordCountCurrent - this.currentSession.wordCountStart;
    }
    return {
      todayWords: this.todayWords,
      dailyWordGoal: this.config.dailyWordGoal,
      streak: this.streak,
      goalPercent,
      enableReminders: this.config.enableReminders,
      sessionMinutes,
      sessionWords,
    };
  }

  getContext(): string {
    const parts: string[] = [];

    // Daily goal progress
    const goalPercent = Math.min(100, Math.round((this.todayWords / this.config.dailyWordGoal) * 100));
    parts.push(`Daily word goal: ${this.todayWords}/${this.config.dailyWordGoal} (${goalPercent}%)`);

    // Streak
    if (this.streak > 0) {
      parts.push(`Writing streak: ${this.streak} days 🔥`);
    }

    // Active session
    if (this.currentSession) {
      const minutes = Math.round((Date.now() - this.currentSession.startTime.getTime()) / 60000);
      const sessionWords = this.currentSession.wordCountCurrent - this.currentSession.wordCountStart;
      parts.push(`Active session: ${minutes}min, ${sessionWords} words this session`);
    }

    // Autonomous mode status
    if (this.config.autonomousEnabled) {
      const status = this.autonomousPaused ? '⏸ paused' : this.isRunning ? '🔄 working' : '✅ active';
      parts.push(`Autonomous mode: ${status} (every ${this.config.autonomousIntervalMinutes}min, ${this.totalAutonomousSteps} steps total)`);
    }

    return parts.join('\n');
  }
}
