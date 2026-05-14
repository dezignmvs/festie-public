const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const moment = require('moment');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
let lastQr = '';
let isReady = false;

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccount.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();
const AUTH_PATH = path.join(__dirname, '.auth_info');

// Session Persistence Logic
async function backupSession() {
    console.log('Backing up session to Firestore...');
    try {
        const output = path.join(__dirname, 'session.zip');
        const stream = fs.createWriteStream(output);
        const archive = archiver('zip', { zlib: { level: 9 } });

        return new Promise((resolve, reject) => {
            stream.on('close', async () => {
                const buffer = await fs.readFile(output);
                // Split into chunks if > 1MB (Firestore limit)
                const base64 = buffer.toString('base64');
                await db.collection('system').doc('whatsapp-session').set({
                    data: base64,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                await fs.remove(output);
                console.log('Session backup complete.');
                resolve();
            });
            archive.on('error', reject);
            archive.pipe(stream);
            archive.directory(AUTH_PATH, false);
            archive.finalize();
        });
    } catch (err) {
        console.error('Backup failed:', err);
    }
}

async function restoreSession() {
    console.log('Checking for existing session in Firestore...');
    try {
        const doc = await db.collection('system').doc('whatsapp-session').get();
        if (doc.exists) {
            const data = doc.data().data;
            const buffer = Buffer.from(data, 'base64');
            const zipPath = path.join(__dirname, 'restore.zip');
            await fs.writeFile(zipPath, buffer);
            
            await fs.ensureDir(AUTH_PATH);
            await fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: AUTH_PATH }))
                .promise();
            
            await fs.remove(zipPath);
            console.log('Session restored successfully.');
            return true;
        }
    } catch (err) {
        console.error('Restore failed:', err);
    }
    return false;
}

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: AUTH_PATH
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null // Useful for custom environments
    }
});

// QR Code Generation
client.on('qr', (qr) => {
    lastQr = qr;
    console.log('QR RECEIVED. View it at /qr endpoint.');
    qrcode.generate(qr, { small: true });
});

// Client Authentication
client.on('authenticated', async () => {
    console.log('AUTHENTICATED');
    // We delay backup slightly to ensure session files are written
    setTimeout(backupSession, 10000);
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
});

// Client Ready
client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    isReady = true;
    
    db.collection('system').doc('whatsapp-bot').set({
        status: 'online',
        lastSeen: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    startNotificationListener();
});

// Helper: Handle Incoming Messages to find IDs
client.on('message', async msg => {
    console.log(`Message from ${msg.from}: ${msg.body}`);

    // If you type !id in any group or chat, the bot will tell you the ID
    if (msg.body.toLowerCase() === '!id') {
        msg.reply(`The ID for this chat is: *${msg.from}*`);
        console.log(`CHAT ID DETECTED: ${msg.from}`);
    }
});

// Notification Engine
function startNotificationListener() {
    console.log('Starting notification listeners...');
    
    // 2. Judge Alerts (Polling-based for timing)
    // Runs every minute to check for programs starting in 10 minutes
    setInterval(checkUpcomingPrograms, 60000);
    checkUpcomingPrograms(); // Run once on start
}

async function checkUpcomingPrograms() {
    console.log('Checking for upcoming programs starting in 10 minutes...');
    try {
        const now = moment();
        const targetTime = now.clone().add(10, 'minutes');
        
        // We look for programs where time is set and within the next 10-11 minutes
        // And where we haven't sent the 10m alert yet
        const snapshot = await db.collection('programs')
            .where('judgeAlertSent', '==', false)
            .get();

        const venuesSnap = await db.collection('venues').get();
        const venues = {};
        venuesSnap.forEach(v => venues[v.id] = v.data().name);

        const judgesSnap = await db.collection('judges').get();
        const judges = {};
        judgesSnap.forEach(j => judges[j.id] = j.data());

        for (const doc of snapshot.docs) {
            const p = doc.data();
            if (!p.time) continue;

            const startTime = moment(p.time);
            const diffMinutes = startTime.diff(now, 'minutes');

            // If it's starting in 9-11 minutes, send the alert
            if (diffMinutes >= 9 && diffMinutes <= 11) {
                console.log(`Found program starting soon: ${p.name} (starts in ${diffMinutes}m)`);
                await sendJudgeAlert(doc.id, p, venues, judges, diffMinutes);
                
                // Mark as sent
                await db.collection('programs').doc(doc.id).update({ judgeAlertSent: true });
            }
        }
    } catch (err) {
        console.error('Error checking upcoming programs:', err);
    }
}

async function sendJudgeAlert(programId, program, venues, judges, minutesLeft) {
    const venueName = venues[program.venueId] || 'Not Assigned';
    
    // Collect all judges assigned to this program
    const assignedJudgeIds = [];
    for (let i = 1; i <= (program.judgeCount || 3); i++) {
        const jId = program[`judge${i}Id`];
        if (jId) assignedJudgeIds.push(jId);
    }

    const uniqueJudgeIds = [...new Set(assignedJudgeIds)];
    
    for (const jId of uniqueJudgeIds) {
        const judge = judges[jId];
        if (judge && judge.whatsapp) {
            let phone = judge.whatsapp.replace(/\D/g, '');
            if (!phone.startsWith('91') && phone.length === 10) phone = '91' + phone;
            const target = `${phone}@c.us`;

            const message = `*⏰ JUDGE ALERT: STARTING SOON! ⏰*\n\n` +
                          `Hello *${judge.name}*,\n\n` +
                          `The following program is scheduled to start in *${minutesLeft} minutes*:\n\n` +
                          `📌 *Program:* ${program.name}\n` +
                          `🔢 *Code:* ${program.code || 'N/A'}\n` +
                          `📍 *Venue:* ${venueName}\n` +
                          `🕒 *Time:* ${moment(program.time).format('hh:mm A')}\n\n` +
                          `Please proceed to the venue. Thank you! 🙏`;

            try {
                await client.sendMessage(target, message);
                console.log(`Alert sent to Judge ${judge.name} for ${program.name}`);
            } catch (err) {
                console.error(`Failed to send alert to Judge ${judge.name}:`, err);
            }
        }
    }
}

// HTML Template for Status Pages
const getStatusTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FestNotify WhatsApp Status</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
    <link rel='stylesheet' href='https://cdn-uicons.flaticon.com/2.1.0/uicons-regular-rounded/css/uicons-regular-rounded.css'>
    <style>
        body { font-family: 'Outfit', sans-serif; background: #0f172a; color: white; }
        .glass { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.05); }
        .glow { box-shadow: 0 0 20px rgba(59, 130, 246, 0.3); }
        .status-dot { width: 12px; height: 12px; border-radius: 50%; }
        .dot-online { background: #10b981; box-shadow: 0 0 10px #10b981; }
        .dot-offline { background: #ef4444; box-shadow: 0 0 10px #ef4444; }
    </style>
</head>
<body class="min-h-screen flex items-center justify-center p-6">
    <div class="max-w-md w-full glass rounded-[2.5rem] p-8 text-center relative overflow-hidden">
        <div class="absolute -top-24 -right-24 w-48 h-48 bg-blue-600/20 blur-[80px]"></div>
        <div class="absolute -bottom-24 -left-24 w-48 h-48 bg-purple-600/20 blur-[80px]"></div>
        
        <div class="mb-8 flex justify-center">
            <div class="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-600/20">
                <i class="fi fi-rr-comment-alt text-3xl text-white"></i>
            </div>
        </div>
        
        ${content}
        
        <div class="mt-8 pt-8 border-t border-white/5 text-[10px] text-gray-500 uppercase tracking-[0.2em]">
            FestNotify Engine v1.0 • Powered by ArtFest
        </div>
    </div>
</body>
</html>
`;

// Web Interface Endpoints
app.get('/', (req, res) => {
    const statusContent = `
        <h1 class="text-2xl font-bold mb-2">WhatsApp Service</h1>
        <p class="text-gray-400 text-sm mb-8">Notification engine status monitor</p>
        
        <div class="glass rounded-2xl p-6 flex flex-col gap-4 mb-6">
            <div class="flex items-center justify-between">
                <span class="text-xs text-gray-400 uppercase tracking-widest font-semibold">Engine Status</span>
                <div class="flex items-center gap-2">
                    <div class="status-dot ${isReady ? 'dot-online' : 'dot-offline'}"></div>
                    <span class="text-xs font-bold ${isReady ? 'text-emerald-400' : 'text-red-400'}">${isReady ? 'ONLINE' : 'OFFLINE'}</span>
                </div>
            </div>
            <div class="h-px bg-white/5 w-full"></div>
            <div class="flex items-center justify-between">
                <span class="text-xs text-gray-400 uppercase tracking-widest font-semibold">Device Linked</span>
                <span class="text-xs font-bold text-blue-400">${isReady ? 'CONNECTED' : 'WAITING'}</span>
            </div>
        </div>

        ${!isReady ? `
            <a href="/qr" class="block w-full py-4 bg-white text-slate-900 rounded-xl font-bold hover:scale-[1.02] transition-transform active:scale-95 shadow-xl">
                LINK DEVICE
            </a>
        ` : `
            <div class="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm font-medium">
                <i class="fi fi-rr-check-circle mr-2"></i> All systems operational
            </div>
        `}
    `;
    res.send(getStatusTemplate(statusContent));
});

app.get('/qr', (req, res) => {
    if (isReady) {
        return res.redirect('/');
    }
    
    if (!lastQr) {
        return res.send(getStatusTemplate(`
            <h1 class="text-2xl font-bold mb-2">Generating QR...</h1>
            <p class="text-gray-400 text-sm mb-8">Please wait while we initialize the browser engine</p>
            <div class="w-full aspect-square glass rounded-2xl flex items-center justify-center mb-6">
                <div class="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
            <script>setTimeout(() => window.location.reload(), 2000)</script>
        `));
    }

    const qrContent = `
        <h1 class="text-2xl font-bold mb-2">Link WhatsApp</h1>
        <p class="text-gray-400 text-sm mb-8">Scan the code with your phone to start</p>
        
        <div class="w-full aspect-square bg-white p-4 rounded-3xl mb-8 glow flex items-center justify-center">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQr)}" class="w-full h-full">
        </div>
        
        <ol class="text-left text-xs text-gray-400 space-y-2 mb-4 px-2">
            <li>1. Open WhatsApp on your phone</li>
            <li>2. Go to Settings > Linked Devices</li>
            <li>3. Tap on Link a Device</li>
            <li>4. Point your camera at this screen</li>
        </ol>

        <script>
            // Refresh logic to check for ready status
            setInterval(async () => {
                try {
                    const resp = await fetch('/');
                    if (resp.url.endsWith('/') && !resp.url.includes('/qr')) window.location.href = '/';
                } catch(e) {}
            }, 3000);
        </script>
    `;
    res.send(getStatusTemplate(qrContent));
});

// Start Server and WhatsApp
async function start() {
    await restoreSession();
    
    app.listen(PORT, () => {
        console.log(`Web server running at http://localhost:${PORT}`);
    });

    client.initialize();
}

start();

// Handle process termination for cleanup
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await client.destroy();
    process.exit(0);
});
