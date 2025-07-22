const axios = require('axios');
const cron = require('node-cron');
const git = require('simple-git');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

class KlaviyoDeveloperTracker {
    constructor() {
        this.apiKey = process.env.KLAVIYO_API_KEY;
        this.developerEmail = process.env.DEVELOPER_EMAIL;
        this.developerName = process.env.DEVELOPER_NAME;
        this.repoPath = process.env.REPO_PATH || '.';
        this.metricPrefix = process.env.METRIC_PREFIX || 'developer_productivity';
        
        this.gitRepo = git(this.repoPath);
        this.trackingDataPath = path.join(__dirname, 'tracking-data.json');
        
        // Initialize tracking data
        this.loadTrackingData();
    }

    /**
     * Load existing tracking data or create new file
     */
    loadTrackingData() {
        try {
            if (fs.existsSync(this.trackingDataPath)) {
                this.trackingData = JSON.parse(fs.readFileSync(this.trackingDataPath, 'utf8'));
            } else {
                this.trackingData = {
                    lastCommitHash: null,
                    dailyCommitCount: 0,
                    streakDays: 0,
                    totalCommits: 0,
                    lastActiveDate: null,
                    achievements: []
                };
                this.saveTrackingData();
            }
        } catch (error) {
            console.error('Error loading tracking data:', error);
            this.trackingData = {
                lastCommitHash: null,
                dailyCommitCount: 0,
                streakDays: 0,
                totalCommits: 0,
                lastActiveDate: null,
                achievements: []
            };
        }
    }

    /**
     * Save tracking data to file
     */
    saveTrackingData() {
        fs.writeFileSync(this.trackingDataPath, JSON.stringify(this.trackingData, null, 2));
    }

    /**
     * Send event to Klaviyo
     */
    async sendKlaviyoEvent(metricName, properties = {}) {
        try {
            const eventData = {
                data: {
                    type: 'event',
                    attributes: {
                        properties: {
                            ...properties,
                            timestamp: new Date().toISOString()
                        },
                        metric: {
                            data: {
                                type: 'metric',
                                attributes: {
                                    name: `${this.metricPrefix}.${metricName}`
                                }
                            }
                        },
                        profile: {
                            data: {
                                type: 'profile',
                                attributes: {
                                    email: this.developerEmail,
                                    first_name: this.developerName.split(' ')[0] || 'Developer',
                                    last_name: this.developerName.split(' ').slice(1).join(' ') || ''
                                }
                            }
                        }
                    }
                }
            };

            const response = await axios.post('https://a.klaviyo.com/api/events/', eventData, {
                headers: {
                    'Authorization': `Klaviyo-API-Key ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'revision': '2024-10-15'
                }
            });

            console.log(`✅ Event '${metricName}' sent to Klaviyo successfully`);
            return response.data;
        } catch (error) {
            console.error(`❌ Error sending event '${metricName}' to Klaviyo:`, error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Get recent git activity
     */
    async getGitActivity() {
        try {
            // Get recent commits from today
            const today = new Date().toISOString().split('T')[0];
            const commits = await this.gitRepo.log({
                since: today,
                until: `${today} 23:59:59`
            });

            // Get current branch info
            const branch = await this.gitRepo.branchLocal();
            const status = await this.gitRepo.status();

            return {
                todayCommits: commits.all,
                currentBranch: branch.current,
                hasUncommittedChanges: status.files.length > 0,
                modifiedFiles: status.files.length
            };
        } catch (error) {
            console.error('Error getting git activity:', error);
            return null;
        }
    }

    /**
     * Analyze commit activity and send relevant events
     */
    async analyzeAndSendEvents() {
        const activity = await this.getGitActivity();
        if (!activity) return;

        const today = new Date().toISOString().split('T')[0];
        const isNewDay = this.trackingData.lastActiveDate !== today;

        // Check for new commits
        const newCommits = activity.todayCommits.filter(commit => 
            commit.hash !== this.trackingData.lastCommitHash
        );

        if (newCommits.length > 0) {
            // Update tracking data
            const latestCommit = newCommits[0];
            this.trackingData.lastCommitHash = latestCommit.hash;
            this.trackingData.totalCommits += newCommits.length;
            
            if (isNewDay) {
                this.trackingData.dailyCommitCount = newCommits.length;
                this.trackingData.streakDays += 1;
                this.trackingData.lastActiveDate = today;
            } else {
                this.trackingData.dailyCommitCount += newCommits.length;
            }

            // Send commit event
            await this.sendKlaviyoEvent('commit_made', {
                commit_hash: latestCommit.hash.substring(0, 8),
                commit_message: latestCommit.message,
                author: latestCommit.author_name,
                branch: activity.currentBranch,
                files_changed: latestCommit.diff?.files?.length || 0,
                daily_commit_count: this.trackingData.dailyCommitCount,
                total_commits: this.trackingData.totalCommits,
                streak_days: this.trackingData.streakDays
            });

            // Check for achievements
            await this.checkAndSendAchievements();
        }

        // Check for uncommitted changes (gentle reminder)
        if (activity.hasUncommittedChanges && activity.modifiedFiles > 5) {
            await this.sendKlaviyoEvent('many_uncommitted_changes', {
                modified_files_count: activity.modifiedFiles,
                current_branch: activity.currentBranch,
                reminder_type: 'commit_reminder'
            });
        }

        this.saveTrackingData();
    }

    /**
     * Check for achievements and send celebration events
     */
    async checkAndSendAchievements() {
        const achievements = [];

        // First commit achievement
        if (this.trackingData.totalCommits === 1) {
            achievements.push('first_commit');
        }

        // Daily commitment achievements
        if (this.trackingData.dailyCommitCount === 5) {
            achievements.push('daily_5_commits');
        } else if (this.trackingData.dailyCommitCount === 10) {
            achievements.push('daily_10_commits');
        }

        // Streak achievements
        if (this.trackingData.streakDays === 7) {
            achievements.push('week_streak');
        } else if (this.trackingData.streakDays === 30) {
            achievements.push('month_streak');
        }

        // Milestone achievements
        if ([10, 50, 100, 500, 1000].includes(this.trackingData.totalCommits)) {
            achievements.push(`${this.trackingData.totalCommits}_commits_milestone`);
        }

        // Send achievement events
        for (const achievement of achievements) {
            if (!this.trackingData.achievements.includes(achievement)) {
                await this.sendKlaviyoEvent('achievement_unlocked', {
                    achievement_type: achievement,
                    total_commits: this.trackingData.totalCommits,
                    streak_days: this.trackingData.streakDays,
                    daily_commits: this.trackingData.dailyCommitCount,
                    celebration: true
                });
                
                this.trackingData.achievements.push(achievement);
                console.log(`🎉 Achievement unlocked: ${achievement}`);
            }
        }
    }

    /**
     * Send daily summary if it's end of day
     */
    async sendDailySummary() {
        const now = new Date();
        const isEndOfDay = now.getHours() === 22; // 10 PM

        if (isEndOfDay && this.trackingData.dailyCommitCount > 0) {
            await this.sendKlaviyoEvent('daily_summary', {
                commits_today: this.trackingData.dailyCommitCount,
                streak_days: this.trackingData.streakDays,
                total_commits: this.trackingData.totalCommits,
                productivity_score: this.calculateProductivityScore(),
                summary_type: 'end_of_day'
            });
        }
    }

    /**
     * Calculate a simple productivity score
     */
    calculateProductivityScore() {
        const baseScore = Math.min(this.trackingData.dailyCommitCount * 10, 100);
        const streakBonus = Math.min(this.trackingData.streakDays * 2, 50);
        return Math.min(baseScore + streakBonus, 150);
    }

    /**
     * Send a test event to verify integration
     */
    async sendTestEvent() {
        try {
            await this.sendKlaviyoEvent('tracker_started', {
                message: 'Developer productivity tracker is now active!',
                setup_complete: true,
                developer_name: this.developerName,
                repository_path: this.repoPath
            });
            console.log('🚀 Test event sent successfully! Klaviyo integration is working.');
        } catch (error) {
            console.error('❌ Test event failed. Please check your API key and configuration.');
        }
    }

    /**
     * Start the tracking system
     */
    start() {
        console.log('🎯 Starting Klaviyo Developer Productivity Tracker...');
        console.log(`📧 Developer: ${this.developerName} (${this.developerEmail})`);
        console.log(`📁 Repository: ${this.repoPath}`);
        
        // Send initial test event
        this.sendTestEvent();

        // Check for activity every 30 seconds
        cron.schedule('*/30 * * * * *', () => {
            this.analyzeAndSendEvents();
        });

        // Send daily summary at 10 PM
        cron.schedule('0 22 * * *', () => {
            this.sendDailySummary();
        });

        console.log('⏰ Tracker is now running. Press Ctrl+C to stop.');
    }

    /**
     * Manual commit check (for testing)
     */
    async checkNow() {
        console.log('🔍 Checking for new activity...');
        await this.analyzeAndSendEvents();
    }
}

// CLI interface
if (require.main === module) {
    const tracker = new KlaviyoDeveloperTracker();
    
    const command = process.argv[2];
    
    if (command === 'test') {
        tracker.sendTestEvent();
    } else if (command === 'check') {
        tracker.checkNow();
    } else if (command === 'start') {
        tracker.start();
    } else {
        console.log(`
🎯 Klaviyo Developer Productivity Tracker

Usage:
  node index.js start    - Start the continuous tracking
  node index.js test     - Send a test event to Klaviyo
  node index.js check    - Check for new activity once

Make sure to configure your .env file with your Klaviyo API key!
        `);
    }
}

module.exports = KlaviyoDeveloperTracker;