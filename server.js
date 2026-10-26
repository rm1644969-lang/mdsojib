const express = require('express');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264';
const DEFAULT_PASSWORD = 'Pass12345!';

// ============================================================================
// SERVER-SIDE BACKGROUND MONITOR ENGINE
// (Continues polling code.yamin.bd 24/7 on PC even when phone is minimized)
// ============================================================================
let serverAccounts = [];
let isServerMonitoring = false;
let serverPollInterval = 3000;
let serverMonitorTimer = null;
let serverLatestOtps = [];
let sseClients = [];

// Helper to broadcast SSE event to all connected phones/browsers
function broadcastSse(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const client = sseClients[i];
    try {
      client.write(payload);
    } catch (e) {
      sseClients.splice(i, 1);
    }
  }
}

// Helper functions for parsing OTP from emails (Hotmail/Outlook via code.yamin.bd)
function decodeBase64Utf8(b64) {
  if (!b64) return '';
  try {
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch (_) {
    return '';
  }
}

function extractTextSnippet(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCodeInText(subject, body) {
  const subj = subject || '';
  // Check for spaced code in subject e.g. "123 456 is your Instagram code" or "123-456"
  const subjSpaced = subj.match(/\b(\d{3})[\s-](\d{3})\b/);
  if (subjSpaced) return subjSpaced[1] + subjSpaced[2];

  const subjMatch = subj.match(/\b(\d{4,8})\b/);
  if (subjMatch && !subjMatch[1].match(/^(19|20)\d{2}$/)) {
    return subjMatch[1];
  }

  let text = (body || '')
    .replace(/\b\d{4}[-\/]\d{2}[-\/]\d{2}\b/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\b94025\b/g, '')
    .replace(/\b\d{10,}\b/g, '');

  const spacedMatch = text.match(/(?:code|otp|pin|password|verification)[^\d]{0,25}(\d{3})[\s-](\d{3})\b/i);
  if (spacedMatch) return spacedMatch[1] + spacedMatch[2];

  const contextMatch = text.match(/(?:code|otp|pin|password|verification|confirm)[^\d]{0,25}(\d{4,8})/i);
  if (contextMatch && !contextMatch[1].match(/^(19|20)\d{2}$/)) {
    return contextMatch[1];
  }

  const match58 = text.match(/(?:^|\s|>|:|-)(\d{5,8})(?:$|\s|<|\.|,|-)/) || text.match(/\b(\d{5,8})\b/);
  if (match58) return match58[1];

  const match4 = text.match(/\b(?!(?:19|20)\d{2}\b)(\d{4})\b/);
  return match4 ? match4[1] : null;
}

function detectServiceIcon(text, defaultIcon) {
  const str = String(text || '').toLowerCase();
  if (str.includes('instagram')) return 'fa-brands fa-instagram';
  if (str.includes('facebook') || str.includes('meta')) return 'fa-brands fa-facebook';
  if (str.includes('google')) return 'fa-brands fa-google';
  if (str.includes('whatsapp')) return 'fa-brands fa-whatsapp';
  if (str.includes('microsoft')) return 'fa-brands fa-microsoft';
  if (str.includes('telegram')) return 'fa-brands fa-telegram';
  if (str.includes('twitter') || str.includes(' x ')) return 'fa-brands fa-x-twitter';
  if (str.includes('apple')) return 'fa-brands fa-apple';
  return defaultIcon || 'fa-solid fa-key';
}

// Extract OTP code and icon from API response (Fully compatible with code.yamin.bd)
function extractOtpAndDetails(data) {
  if (!data) return { code: null, icon: 'fa-solid fa-key', messages: [] };

  let detectedIcon = data.icon || 'fa-solid fa-key';
  let messageList = [];

  // 1. Direct top-level code if valid
  if (data.code && String(data.code).trim() !== '------') {
    const c = String(data.code).trim();
    return { code: c, icon: detectServiceIcon(data.service || data.content, detectedIcon), messages: [] };
  }
  if (data.otp && String(data.otp).trim() !== '------') {
    const c = String(data.otp).trim();
    return { code: c, icon: detectServiceIcon(data.service || data.content, detectedIcon), messages: [] };
  }
  if (data.verification_code) {
    const c = String(data.verification_code).trim();
    return { code: c, icon: detectServiceIcon(data.service || data.content, detectedIcon), messages: [] };
  }
  if (data.data && (data.data.code || data.data.otp)) {
    const c = String(data.data.code || data.data.otp).trim();
    if (c && c !== '------') {
      return { code: c, icon: detectServiceIcon(data.data.service, detectedIcon), messages: [] };
    }
  }

  // 2. Scan messages array (Crucial for Instagram and code.yamin.bd)
  if (Array.isArray(data.messages) && data.messages.length > 0) {
    messageList = data.messages;
    for (const msg of data.messages) {
      if (!msg) continue;
      const subject = msg.subject || '';
      const sender = msg.senderName || msg.from || '';
      detectedIcon = msg.icon || detectServiceIcon(subject + ' ' + sender, detectedIcon);

      // Check if message object already has extracted code
      if (msg.code && String(msg.code).trim() !== '------') {
        const c = String(msg.code).trim();
        if (/^\d{4,8}$/.test(c) && !/^(19|20)\d{2}$/.test(c)) {
          return { code: c, icon: detectedIcon, messages: messageList };
        }
      }

      // Check subject and body
      let body = msg.message || '';
      if (!body && msg.message_b64) {
        body = decodeBase64Utf8(msg.message_b64);
      }
      const snippet = extractTextSnippet(body);
      const extracted = findCodeInText(subject, snippet || body);
      if (extracted) {
        return { code: extracted, icon: detectedIcon, messages: messageList };
      }
    }
  }

  // 3. Fallback to scanning content/message text
  const textToScan = [
    typeof data.content === 'string' ? data.content : '',
    typeof data.message === 'string' ? data.message : ''
  ].filter(Boolean).join(' ');

  if (textToScan) {
    const extracted = findCodeInText('', textToScan);
    if (extracted) {
      return { code: extracted, icon: detectServiceIcon(textToScan, detectedIcon), messages: messageList };
    }
  }

  return { code: null, icon: detectedIcon, messages: messageList };
}

// Background cycle execution on PC server
async function runServerMonitorCycle() {
  if (!isServerMonitoring || serverAccounts.length === 0) return;

  // Poll all accounts in parallel for instant 300ms cycle
  await Promise.all(
    serverAccounts.map(async (account) => {
      const payload = {
        email: account.email,
        password: account.password || DEFAULT_PASSWORD,
        refresh_token: account.refreshToken,
        client_id: account.clientId || DEFAULT_CLIENT_ID
      };
      if (account.recoveryEmail) {
        payload.recovery_email = account.recoveryEmail;
      }

      try {
        const res = await fetch('https://code.yamin.bd/api.php?action=fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(6000)
        });
        const result = await res.json();
        const { code, icon, messages } = extractOtpAndDetails(result);

        if (code) {
          if (!account.isBaselineDone) {
            // First time checking account on server: record existing code as baseline, NEVER broadcast old code
            account.isBaselineDone = true;
            account.lastSeenCode = code;
            console.log(`[SERVER BASELINE] ${account.email} existing code ${code} recorded (ignored as old OTP)`);
          } else if (account.lastSeenCode !== code) {
            // A genuine NEW OTP arrived!
            account.lastSeenCode = code;
            console.log(`⚡ [SERVER NEW OTP CAPTURED] ${account.email} => ${code}`);

            const otpEvent = {
              id: 'otp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
              email: account.email,
              code: code,
              icon: icon,
              time: new Date().toLocaleTimeString(),
              timestamp: Date.now(),
              messages: messages
            };

            serverLatestOtps.unshift(otpEvent);
            if (serverLatestOtps.length > 50) serverLatestOtps.pop();

            broadcastSse('NEW_OTP', otpEvent);
          }
        } else {
          account.isBaselineDone = true;
        }
        } catch (err) {
          // Silent catch to keep loop running
        }
      })
    );
}

function startServerMonitoring() {
  if (serverMonitorTimer) clearInterval(serverMonitorTimer);
  isServerMonitoring = true;
  console.log(`▶ Server Background Monitoring STARTED for ${serverAccounts.length} accounts`);
  runServerMonitorCycle();
  serverMonitorTimer = setInterval(runServerMonitorCycle, serverPollInterval);
}

function stopServerMonitoring() {
  isServerMonitoring = false;
  if (serverMonitorTimer) {
    clearInterval(serverMonitorTimer);
    serverMonitorTimer = null;
  }
  console.log('⏹ Server Background Monitoring STOPPED');
}

// Helper to get local network IPv4 address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Endpoint: Network info & QR code data
app.get('/api/network-info', async (req, res) => {
  const localIp = getLocalIp();
  const fullUrl = `http://${localIp}:${PORT}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(fullUrl, {
      width: 280,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });
    res.json({
      localIp,
      port: PORT,
      fullUrl,
      qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Sync accounts & monitor state from Phone/PC
app.post('/api/monitor/sync', (req, res) => {
  const { accounts, isMonitoring, pollInterval } = req.body;
  if (Array.isArray(accounts)) {
    serverAccounts = accounts.map((incomingAcc) => {
      const existing = serverAccounts.find((s) => s.email.toLowerCase() === incomingAcc.email.toLowerCase());
      return {
        ...incomingAcc,
        isBaselineDone: existing ? existing.isBaselineDone : (incomingAcc.isBaselineDone || false),
        lastSeenCode: existing ? existing.lastSeenCode : (incomingAcc.lastSeenCode || null)
      };
    });
  }
  if (pollInterval && pollInterval >= 2000) {
    serverPollInterval = pollInterval;
  }

  if (isMonitoring && !isServerMonitoring) {
    startServerMonitoring();
  } else if (!isMonitoring && isServerMonitoring) {
    stopServerMonitoring();
  }

  res.json({
    status: true,
    serverMonitoring: isServerMonitoring,
    accountCount: serverAccounts.length
  });
});

// SSE endpoint for instant live push to phones
app.get('/api/monitor/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');
  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// Get latest captured OTPs (for fast sync when phone wakes up)
app.get('/api/monitor/latest-otps', (req, res) => {
  res.json({
    status: true,
    isMonitoring: isServerMonitoring,
    otps: serverLatestOtps
  });
});

// Proxy endpoint to code.yamin.bd (with smart defaults)
app.post('/api/proxy-fetch', async (req, res) => {
  const payload = { ...req.body };
  if (!payload.client_id) {
    payload.client_id = DEFAULT_CLIENT_ID;
  }
  if (!payload.password) {
    payload.password = DEFAULT_PASSWORD;
  }

  try {
    const response = await fetch('https://code.yamin.bd/api.php?action=fetch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      status: false,
      error: error.message || 'Proxy request failed'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`=======================================================`);
  console.log(`🚀 MailCode OTP Monitor App is running!`);
  console.log(`💻 Local PC Access:    http://localhost:${PORT}`);
  console.log(`📱 Phone Access:       http://${localIp}:${PORT}`);
  console.log(`   (Open the phone URL on the same Wi-Fi to use as an app)`);
  console.log(`=======================================================`);
});

