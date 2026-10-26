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
let serverPollInterval = 5000;
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

// Extract OTP code from API response
function extractOtp(data) {
  if (!data) return null;
  if (data.code) return String(data.code).trim();
  if (data.otp) return String(data.otp).trim();
  if (data.verification_code) return String(data.verification_code).trim();
  if (data.data && (data.data.code || data.data.otp)) {
    return String(data.data.code || data.data.otp).trim();
  }

  const textToScan = [
    data.content,
    data.message,
    ...(Array.isArray(data.messages) ? data.messages : [])
  ].filter(Boolean).join(' ');

  if (textToScan) {
    const match = textToScan.match(/(?:code|otp|verification|pin|password)[\s:=#is]+([0-9]{4,8})/i)
      || textToScan.match(/\b([0-9]{6})\b/)
      || textToScan.match(/\b([0-9]{4,8})\b/);
    if (match) return match[1].trim();
  }
  return null;
}

// Background cycle execution on PC server
async function runServerMonitorCycle() {
  if (!isServerMonitoring || serverAccounts.length === 0) return;

  const batchSize = Math.min(3, serverAccounts.length);
  for (let b = 0; b < serverAccounts.length; b += batchSize) {
    if (!isServerMonitoring) break;
    const batch = serverAccounts.slice(b, b + batchSize);

    await Promise.all(
      batch.map(async (account) => {
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
            signal: AbortSignal.timeout(15000)
          });
          const result = await res.json();
          const otp = extractOtp(result);

          if (otp) {
            if (account.lastSeenCode !== otp) {
              account.lastSeenCode = otp;
              console.log(`⚡ [SERVER OTP CAPTURED] ${account.email} => ${otp}`);

              const otpEvent = {
                id: 'otp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                email: account.email,
                code: otp,
                icon: result.icon || 'fa-solid fa-key',
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now(),
                messages: result.messages || (result.content ? [result.content] : [])
              };

              serverLatestOtps.unshift(otpEvent);
              if (serverLatestOtps.length > 50) serverLatestOtps.pop();

              broadcastSse('NEW_OTP', otpEvent);
            }
          }
        } catch (err) {
          // Silent catch to keep loop running
        }
      })
    );
  }
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
    serverAccounts = accounts;
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

