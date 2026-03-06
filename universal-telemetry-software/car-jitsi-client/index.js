#!/usr/bin/env node
/**
 * Headless Jitsi Client for Car RPI
 *
 * Auto-joins a Jitsi meeting and retries indefinitely if base station unavailable.
 * Designed to run on Raspberry Pi with PulseAudio for driver audio.
 * Supports USB camera and mic on any port — gracefully handles missing devices.
 */

const puppeteer = require('puppeteer');

// Configuration from environment
const CONFIG = {
    jitsiUrl: process.env.JITSI_URL || 'http://192.168.1.1:8000',
    roomName: process.env.ROOM_NAME || 'wfr-comms',
    displayName: process.env.DISPLAY_NAME || 'Driver',
    retryIntervalMs: parseInt(process.env.RETRY_INTERVAL_MS || '5000'),
    maxRetries: parseInt(process.env.MAX_RETRIES || '-1'), // -1 = infinite
    enableAudio: process.env.ENABLE_AUDIO !== 'false', // true by default
    enableVideo: process.env.ENABLE_VIDEO !== 'false', // true by default
};

let browser = null;
let page = null;
let retryCount = 0;
let isConnected = false;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const logError = (msg) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);

async function launchBrowser() {
    log('Launching headless browser...');

    browser = await puppeteer.launch({
        headless: 'shell', // 'shell' mode is more reliable for real media devices on RPi
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--use-fake-ui-for-media-stream', // Auto-grant mic/camera permissions
            // No --use-fake-device-for-media-stream: we want real devices
            '--alsa-output-device=default',
            '--enable-features=AudioServiceOutOfProcess',
            '--autoplay-policy=no-user-gesture-required',
        ],
        ignoreDefaultArgs: ['--mute-audio'],
    });

    page = await browser.newPage();

    // Permissions handled by CLI args --use-fake-ui-for-media-stream

    // Listen for console messages
    page.on('console', msg => {
        if (msg.type() === 'error') {
            logError(`Browser: ${msg.text()}`);
        }
    });

    log('Browser launched');
}

async function joinMeeting() {
    // Start muted — we unmute after detecting available devices
    const meetingUrl = `${CONFIG.jitsiUrl}/${CONFIG.roomName}#userInfo.displayName="${encodeURIComponent(CONFIG.displayName)}"&config.prejoinPageEnabled=false&config.startWithAudioMuted=true&config.startWithVideoMuted=true&config.disableDeepLinking=true`;

    log(`Joining meeting: ${meetingUrl}`);

    try {
        await page.goto(meetingUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        await page.waitForSelector('div#videoconference_page, div#prejoinPage', {
            timeout: 60000
        });

        // If prejoin page shows, click join
        try {
            const joinButton = await page.$('button[data-testid="prejoin.joinMeeting"]');
            if (joinButton) {
                await joinButton.click();
                log('Clicked join button on prejoin page');
            }
        } catch (e) {
            // No prejoin page, already joining
        }

        await page.waitForSelector('.videocontainer', { timeout: 60000 });

        isConnected = true;
        retryCount = 0;
        log('Successfully joined meeting!');

        // Detect devices and unmute what's available
        await enableAvailableDevices();

        return true;
    } catch (error) {
        logError(`Failed to join: ${error.message}`);
        isConnected = false;
        return false;
    }
}

async function enableAvailableDevices() {
    // Wait a moment for Jitsi's internal API to initialize
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
        const result = await page.evaluate(async (enableAudio, enableVideo) => {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const hasAudio = devices.some(d => d.kind === 'audioinput' && d.deviceId);
            const hasVideo = devices.some(d => d.kind === 'videoinput' && d.deviceId);
            const status = { hasAudio, hasVideo, unmutedAudio: false, unmutedVideo: false };

            if (typeof APP !== 'undefined' && APP.conference) {
                if (hasAudio && enableAudio) {
                    APP.conference.muteAudio(false);
                    status.unmutedAudio = true;
                }
                if (hasVideo && enableVideo) {
                    APP.conference.muteVideo(false);
                    status.unmutedVideo = true;
                }
            }

            return status;
        }, CONFIG.enableAudio, CONFIG.enableVideo);

        log(`Device detection: audio=${result.hasAudio}, video=${result.hasVideo}`);
        if (result.unmutedAudio) log('Audio unmuted');
        if (result.unmutedVideo) log('Video unmuted');
        if (!result.hasAudio && CONFIG.enableAudio) log('No audio input device found — staying muted');
        if (!result.hasVideo && CONFIG.enableVideo) log('No video input device found — staying muted');
    } catch (e) {
        logError(`Device detection failed: ${e.message}`);
    }
}

async function monitorConnection() {
    log('Monitoring connection...');

    while (true) {
        await new Promise(resolve => setTimeout(resolve, 5000));

        try {
            // Check if still on meeting page
            const videoContainer = await page.$('.videocontainer');
            const disconnectOverlay = await page.$('.otr-error');

            if (!videoContainer || disconnectOverlay) {
                log('Connection lost, will attempt to rejoin...');
                isConnected = false;
                return false;
            }
        } catch (e) {
            log('Page check failed, connection may be lost');
            isConnected = false;
            return false;
        }
    }
}

async function run() {
    log('=== Headless Jitsi Client Starting ===');
    log(`Config: ${JSON.stringify(CONFIG, null, 2)}`);

    await launchBrowser();

    while (true) {
        if (CONFIG.maxRetries !== -1 && retryCount >= CONFIG.maxRetries) {
            logError(`Max retries (${CONFIG.maxRetries}) reached. Exiting.`);
            break;
        }

        const joined = await joinMeeting();

        if (joined) {
            // Monitor and wait until disconnected
            await monitorConnection();
            log('Disconnected from meeting');
        }

        retryCount++;
        log(`Retry attempt ${retryCount}${CONFIG.maxRetries !== -1 ? `/${CONFIG.maxRetries}` : ''} in ${CONFIG.retryIntervalMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.retryIntervalMs));
    }

    if (browser) {
        await browser.close();
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    log('Received SIGINT, shutting down...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('Received SIGTERM, shutting down...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

run().catch((error) => {
    logError(`Fatal error: ${error.message}`);
    process.exit(1);
});
