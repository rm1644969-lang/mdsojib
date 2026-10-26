const express = require('express');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// Optional proxy endpoint to code.yamin.bd (fallback if client has CORS or network restrictions)
app.post('/api/proxy-fetch', async (req, res) => {
  try {
    const response = await fetch('https://code.yamin.bd/api.php?action=fetch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
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
