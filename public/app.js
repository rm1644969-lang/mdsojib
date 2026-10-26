/**
 * MailCode OTP Grabber & Auto-Copy App
 * Real-time Hotmail/Outlook OTP monitoring with heads-up SMS notification banner and auto-copy.
 * Features: Background Keep-Alive, Server-Side Parallel Polling, Smart Token Parsing, All-Permissions Setup.
 */

// ============================================================================
// APPLICATION STATE & STORAGE
// ============================================================================
const STORAGE_KEY_ACCOUNTS = 'mailcode_accounts_v1';
const STORAGE_KEY_SETTINGS = 'mailcode_settings_v1';
const STORAGE_KEY_HISTORY = 'mailcode_history_v1';
const STORAGE_KEY_PERMISSIONS = 'mailcode_permissions_granted_v1';

const DEFAULT_CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264';
const DEFAULT_PASSWORD = 'Pass12345!';

let accounts = [];
let history = [];
let settings = {
  autoCopy: true,
  soundAlert: true,
  vibrate: true,
  systemNotif: true,
  pollInterval: 3000,
  isMonitoring: false
};

let monitoringInterval = null;
let bgWorker = null;
let isCurrentlyFetching = false;
let wakeLockSentinel = null;
let audioContext = null;
let bannerTimeout = null;
let sseSource = null;

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  initServiceWorker();
  initDomEvents();
  initServerSse();
  initBackgroundWorker();
  renderAccountsList();
  renderHistoryList();
  updateMetrics();
  checkApiHealth();
  fetchNetworkInfo();
  checkPermissionsOnLoad();

  // If user previously had accounts loaded, auto-start live monitoring
  if (accounts.length > 0) {
    setTimeout(() => {
      if (!settings.isMonitoring) {
        startMonitoring();
      }
    }, 800);
  }
});

// Load saved data
function loadFromStorage() {
  try {
    const savedAccounts = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
    if (savedAccounts) {
      accounts = JSON.parse(savedAccounts);
      // Clean loaded accounts: do NOT show stale OTP boxes on reload/startup
      accounts.forEach((acc) => {
        acc.isBaselineDone = false;
        acc.lastStatus = 'idle';
        acc.lastOtp = null; // Do NOT show old OTP
      });
    }
    
    const savedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (savedSettings) {
      settings = { ...settings, ...JSON.parse(savedSettings) };
      // Reset monitoring to false initially until user starts
      settings.isMonitoring = false;
    }
    
    const savedHistory = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (savedHistory) history = JSON.parse(savedHistory);
  } catch (err) {
    console.error('Failed to load storage:', err);
  }
  
  applySettingsToUI();
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY_ACCOUNTS, JSON.stringify(accounts));
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
  } catch (err) {
    console.error('Failed to save storage:', err);
  }
}

// Service Worker for PWA & Background Notifications
function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('SW Registered:', reg.scope))
      .catch((err) => console.log('SW Reg Failed:', err));

    // Listen for messages from SW (e.g. notification click auto-copy)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'COPY_CODE') {
        const code = event.data.code;
        copyToClipboard(code);
        showToast(`⚡ OTP Code ${code} Auto-Copied!`, 'success');
      }
    });
  }
}

// ============================================================================
// SERVER-SENT EVENTS (SSE) LISTENER
// (Receives OTPs detected by the PC Node server 24/7 even when phone is minimized)
// ============================================================================
function initServerSse() {
  if (!window.EventSource) return;
  try {
    if (sseSource) sseSource.close();
    sseSource = new EventSource('/api/monitor/events');

    sseSource.addEventListener('NEW_OTP', async (e) => {
      try {
        const otpData = JSON.parse(e.data);
        console.log('⚡ [SSE INCOMING OTP]', otpData);
        
        let account = accounts.find((a) => a.email.toLowerCase() === otpData.email.toLowerCase());
        if (!account) {
          account = {
            id: 'acc_srv_' + Date.now(),
            email: otpData.email,
            lastStatus: 'success',
            lastOtp: otpData.code,
            lastSeenCode: otpData.code,
            isBaselineDone: true
          };
          accounts.push(account);
        }

        if (account.lastSeenCode !== otpData.code) {
          account.lastSeenCode = otpData.code;
          account.isBaselineDone = true;
          await handleNewOtp(account, otpData.code, otpData.icon, otpData.messages);
        }
      } catch (err) {
        console.warn('SSE Parse error:', err);
      }
    });

    sseSource.onerror = () => {
      // Reconnect handled automatically by EventSource
    };
  } catch (e) {
    console.warn('SSE Init error:', e);
  }
}

// Sync accounts list and monitoring status with Node server
async function syncWithServerMonitor() {
  try {
    await fetch('/api/monitor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accounts: accounts,
        isMonitoring: settings.isMonitoring,
        pollInterval: settings.pollInterval
      })
    });
  } catch (e) {
    console.log('Server sync fallback (standalone):', e.message);
  }
}

// Fetch latest OTPs from server (called when app wakes up from background/Instagram)
async function fetchLatestServerOtps() {
  try {
    const res = await fetch('/api/monitor/latest-otps');
    if (!res.ok) return;
    const data = await res.json();
    if (data.status && Array.isArray(data.otps) && data.otps.length > 0) {
      for (const item of data.otps) {
        // Only accept if this OTP was captured recently (within last 3 minutes)
        if (Date.now() - item.timestamp > 180000) continue;
        const acc = accounts.find((a) => a.email.toLowerCase() === item.email.toLowerCase());
        if (acc && acc.lastSeenCode !== item.code) {
          acc.lastSeenCode = item.code;
          acc.isBaselineDone = true;
          await handleNewOtp(acc, item.code, item.icon, item.messages);
        }
      }
    }
  } catch (e) {
    // silent catch
  }
}

// ============================================================================
// BACKGROUND WORKER (PREVENTS TIMER THROTTLING WHEN MINIMIZED)
// ============================================================================
function initBackgroundWorker() {
  try {
    const workerCode = `
      let timer = null;
      self.onmessage = function(e) {
        if (e.data.action === 'start') {
          if (timer) clearInterval(timer);
          timer = setInterval(function() {
            self.postMessage('TICK');
          }, e.data.interval || 5000);
        } else if (e.data.action === 'stop') {
          if (timer) clearInterval(timer);
          timer = null;
        }
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    bgWorker = new Worker(URL.createObjectURL(blob));
    bgWorker.onmessage = function(e) {
      if (e.data === 'TICK' && settings.isMonitoring) {
        runMonitoringCycle();
      }
    };
  } catch (e) {
    console.log('Web Worker not supported, using standard timer:', e);
  }
}

// ============================================================================
// INFINITE BACKGROUND KEEP-ALIVE ENGINE (ANTI-FREEZE ON ANDROID/PWA)
// Uses an inaudible live MediaStream pipe + MediaSession to keep the CPU & network alive 24/7
// ============================================================================
let keepAliveAudioCtx = null;
let keepAliveOsc = null;
let isAudioKeepAliveRunning = false;

function startBackgroundKeepAlive() {
  if (isAudioKeepAliveRunning) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      if (!keepAliveAudioCtx || keepAliveAudioCtx.state === 'closed') {
        keepAliveAudioCtx = new AudioCtx();
      }
      if (keepAliveAudioCtx.state === 'suspended') {
        keepAliveAudioCtx.resume();
      }

      // Create live MediaStream destination
      const dest = keepAliveAudioCtx.createMediaStreamDestination();
      keepAliveOsc = keepAliveAudioCtx.createOscillator();
      const gain = keepAliveAudioCtx.createGain();

      // 20Hz sub-audible tone with 0.00005 gain (completely inaudible)
      keepAliveOsc.type = 'sine';
      keepAliveOsc.frequency.setValueAtTime(20, keepAliveAudioCtx.currentTime);
      gain.gain.setValueAtTime(0.00005, keepAliveAudioCtx.currentTime);

      keepAliveOsc.connect(gain);
      gain.connect(dest);
      try {
        gain.connect(keepAliveAudioCtx.destination);
      } catch (_) {}
      keepAliveOsc.start();

      const audioEl = document.getElementById('bgKeepAliveAudio');
      if (audioEl) {
        if ('srcObject' in audioEl) {
          audioEl.srcObject = dest.stream;
        }
        audioEl.volume = 0.01;
        audioEl.play().catch((err) => {
          console.log('Background audio unlock pending user gesture:', err.message);
        });
      }
    }

    // Set up MediaSession metadata so Android marks app as active media
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '⚡ MailCode OTP Live Monitor (Active)',
          artist: 'Background Auto-Copy Active',
          album: 'Real-time 24/7 Monitoring'
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play', () => {
          if (keepAliveAudioCtx && keepAliveAudioCtx.state === 'suspended') {
            keepAliveAudioCtx.resume();
          }
        });
        navigator.mediaSession.setActionHandler('pause', () => {});
      } catch (e) {}
    }

    isAudioKeepAliveRunning = true;
    console.log('⚡ Infinite Background Audio Stream Active (Anti-Freeze)');
  } catch (err) {
    console.warn('Audio keep-alive initialization error:', err);
  }
}

function stopBackgroundKeepAlive() {
  try {
    if (keepAliveOsc) {
      keepAliveOsc.stop();
      keepAliveOsc.disconnect();
      keepAliveOsc = null;
    }
    if (keepAliveAudioCtx && keepAliveAudioCtx.state !== 'closed') {
      keepAliveAudioCtx.suspend();
    }
    const audioEl = document.getElementById('bgKeepAliveAudio');
    if (audioEl) {
      audioEl.pause();
      if ('srcObject' in audioEl) audioEl.srcObject = null;
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  } catch (e) {}
  isAudioKeepAliveRunning = false;
}

// ============================================================================
// AUDIO SYNTHESIZER (SMS ALERT SOUND VIA WEB AUDIO API)
// ============================================================================
function playSmsChime() {
  if (!settings.soundAlert) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    
    if (!audioContext || audioContext.state === 'suspended') {
      audioContext = new AudioCtx();
    }
    
    const now = audioContext.currentTime;
    
    // Tone 1: High crisp ding (880 Hz - A5)
    const osc1 = audioContext.createOscillator();
    const gain1 = audioContext.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, now);
    osc1.frequency.exponentialRampToValueAtTime(1174.66, now + 0.12); // D6
    
    gain1.gain.setValueAtTime(0.6, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    
    osc1.connect(gain1);
    gain1.connect(audioContext.destination);
    
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Tone 2: Harmonious resonance (1760 Hz - A6)
    const osc2 = audioContext.createOscillator();
    const gain2 = audioContext.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1318.51, now + 0.1); // E6
    osc2.frequency.exponentialRampToValueAtTime(1760, now + 0.25); // A6
    
    gain2.gain.setValueAtTime(0.001, now);
    gain2.gain.setValueAtTime(0.7, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    
    osc2.connect(gain2);
    gain2.connect(audioContext.destination);
    
    osc2.start(now + 0.1);
    osc2.stop(now + 0.7);
  } catch (err) {
    console.warn('Audio chime error:', err);
  }
}

// ============================================================================
// VIBRATION & CLIPBOARD
// ============================================================================
function triggerVibration() {
  if (settings.vibrate && 'vibrate' in navigator) {
    try {
      navigator.vibrate([150, 80, 200, 80, 250]);
    } catch (e) {
      console.warn('Vibration blocked:', e);
    }
  }
}

async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback for older webviews or restricted contexts
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    console.warn('Clipboard copy error (will copy on app focus):', err.message);
    return false;
  }
}

// ============================================================================
// SCREEN WAKE LOCK (KEEP MOBILE SCREEN AWAKE WHILE MONITORING)
// ============================================================================
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      updateWakeLockUI(true);
      wakeLockSentinel.addEventListener('release', () => {
        updateWakeLockUI(false);
      });
      return true;
    } catch (err) {
      console.log('WakeLock not granted or supported:', err.message);
      updateWakeLockUI(false);
      return false;
    }
  }
  return false;
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
  updateWakeLockUI(false);
}

function updateWakeLockUI(isActive) {
  const btn = document.getElementById('wakeLockBtn');
  const icon = document.getElementById('wakeLockIcon');
  if (!btn || !icon) return;
  if (isActive) {
    btn.classList.add('active');
    icon.style.color = '#f59e0b';
    btn.title = 'Screen Wake Lock: Active (স্ক্রিন বন্ধ হবে না)';
  } else {
    btn.classList.remove('active');
    icon.style.color = '';
    btn.title = 'Screen Wake Lock: Inactive (ক্লিক করে অন করুন)';
  }
}

let latestCapturedOtp = localStorage.getItem('mailcode_latest_otp') || null;

// Re-acquire wake lock, auto-copy pending OTP, and immediately check latest OTPs if user returns from Instagram
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (latestCapturedOtp && settings.autoCopy) {
      copyToClipboard(latestCapturedOtp);
      showToast(`⚡ OTP ${latestCapturedOtp} Auto-Copied to Clipboard!`, 'success');
    }
    fetchLatestServerOtps();
    if (settings.isMonitoring && accounts.length > 0) {
      runMonitoringCycle();
      requestWakeLock();
      startBackgroundKeepAlive();
    }
  }
});

window.addEventListener('focus', () => {
  if (latestCapturedOtp && settings.autoCopy) {
    copyToClipboard(latestCapturedOtp);
  }
  fetchLatestServerOtps();
  if (settings.isMonitoring && accounts.length > 0) {
    runMonitoringCycle();
  }
});

// ============================================================================
// ALL PERMISSION SETUP MODAL (ONBOARDING)
// ============================================================================
function checkPermissionsOnLoad() {
  const permGranted = localStorage.getItem(STORAGE_KEY_PERMISSIONS);
  updatePermissionBadges();

  const notifNotGranted = ('Notification' in window) && Notification.permission !== 'granted';

  // Automatically open on first entry or if notification permission is not yet allowed
  if (!permGranted || notifNotGranted) {
    setTimeout(() => {
      openPermissionModal();
    }, 400);
  }
}

function updatePermissionBadges() {
  const notifBadge = document.getElementById('permNotifBadge');
  const soundBadge = document.getElementById('permSoundBadge');
  const wakeBadge = document.getElementById('permWakeBadge');
  const permBadgeDot = document.getElementById('permBadgeDot');

  const notifGranted = ('Notification' in window) && Notification.permission === 'granted';
  if (notifBadge) {
    if (notifGranted) {
      notifBadge.textContent = 'Active ✓';
      notifBadge.className = 'perm-status-badge granted';
    } else {
      notifBadge.textContent = 'Required';
      notifBadge.className = 'perm-status-badge';
    }
  }

  if (soundBadge) {
    soundBadge.textContent = settings.soundAlert ? 'Active ✓' : 'Disabled';
    soundBadge.className = settings.soundAlert ? 'perm-status-badge granted' : 'perm-status-badge';
  }

  if (wakeBadge) {
    wakeBadge.textContent = wakeLockSentinel ? 'Active ✓' : 'Ready';
    wakeBadge.className = wakeLockSentinel ? 'perm-status-badge granted' : 'perm-status-badge';
  }

  if (permBadgeDot) {
    permBadgeDot.style.display = notifGranted ? 'none' : 'block';
  }
}

async function grantAllPermissions() {
  // 1. Notification Permission
  if ('Notification' in window) {
    try {
      await Notification.requestPermission();
    } catch (e) {
      console.warn('Notification permission error:', e);
    }
  }

  // 2. Sound & Background Keep-Alive Audio Unlock
  playSmsChime();
  startBackgroundKeepAlive();

  // 3. Screen Wake Lock
  await requestWakeLock();

  // 4. Save state
  localStorage.setItem(STORAGE_KEY_PERMISSIONS, 'true');
  updatePermissionBadges();
  closePermissionModal();

  showToast('✓ সব পারমিশন সফলভাবে চালু হয়েছে!', 'success');

  // If accounts are loaded, start monitoring right away
  if (accounts.length > 0 && !settings.isMonitoring) {
    startMonitoring();
  }
}

function openPermissionModal() {
  updatePermissionBadges();
  document.getElementById('permissionModal').classList.add('active');
}

function closePermissionModal() {
  document.getElementById('permissionModal').classList.remove('active');
}

function openWakeLockModal() {
  document.getElementById('wakeLockModal').classList.add('active');
}

function closeWakeLockModal() {
  document.getElementById('wakeLockModal').classList.remove('active');
}

// ============================================================================
// TOP HEADS-UP SMS NOTIFICATION BANNER
// ============================================================================
function showHeadsUpBanner(otpCode, email, iconClass) {
  const banner = document.getElementById('headsUpBanner');
  const bannerEmail = document.getElementById('bannerEmail');
  const bannerOtpCode = document.getElementById('bannerOtpCode');
  const bannerServiceIcon = document.getElementById('bannerServiceIcon');
  const bannerTime = document.getElementById('bannerTime');
  const progressBar = document.getElementById('bannerProgress');
  
  if (bannerTimeout) clearTimeout(bannerTimeout);

  bannerEmail.textContent = email;
  bannerOtpCode.textContent = otpCode;
  bannerTime.textContent = 'Just now';
  
  // Update service icon
  if (iconClass) {
    bannerServiceIcon.innerHTML = `<i class="${iconClass}"></i>`;
  } else {
    bannerServiceIcon.innerHTML = `<i class="fa-solid fa-key"></i>`;
  }
  
  // Reset and animate progress bar
  progressBar.style.transition = 'none';
  progressBar.style.width = '100%';
  
  // Show banner
  banner.classList.add('show');
  
  // Trigger progress bar countdown
  setTimeout(() => {
    progressBar.style.transition = 'width 8s linear';
    progressBar.style.width = '0%';
  }, 50);

  // Auto hide after 8.5 seconds
  bannerTimeout = setTimeout(() => {
    hideHeadsUpBanner();
  }, 8500);

  // Click on banner to copy again
  banner.onclick = (e) => {
    if (e.target.closest('#bannerCloseBtn')) return;
    copyToClipboard(otpCode);
    showToast(`Code ${otpCode} copied!`, 'success');
  };
}

function hideHeadsUpBanner() {
  const banner = document.getElementById('headsUpBanner');
  banner.classList.remove('show');
  if (bannerTimeout) clearTimeout(bannerTimeout);
}

// Send Native Push Notification (Displays on Mobile Screen even when minimized)
function sendSystemNotification(code, email) {
  if (!settings.systemNotif || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    try {
      const title = `⚡ OTP: ${code}`;
      const options = {
        body: `New verification code for ${email}\nTap here to auto-copy to clipboard!`,
        icon: '/icons/icon-192.svg',
        badge: '/icons/icon-192.svg',
        tag: 'otp-' + Date.now(),
        renotify: true,
        vibrate: [300, 100, 300, 100, 300],
        requireInteraction: true,
        data: { code: code, email: email },
        actions: [
          { action: 'copy', title: '📋 Copy Code' }
        ]
      };
      
      // Preferred: Route through ServiceWorker (vital for background display on Android)
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'SHOW_NOTIFICATION',
          title: title,
          options: options
        });
      } else if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, options);
        });
      } else {
        new Notification(title, options);
      }
    } catch (e) {
      console.warn('System notification error:', e);
    }
  }
}

// ============================================================================
// CORE OTP HANDLER (TRIGGERED WHEN A NEW OTP IS FOUND)
// ============================================================================
async function handleNewOtp(account, otpCode, iconClass, messages) {
  console.log(`🚀 [NEW OTP CAPTURED] ${account.email} => ${otpCode}`);

  // Save latest OTP globally
  latestCapturedOtp = otpCode;
  try {
    localStorage.setItem('mailcode_latest_otp', otpCode);
  } catch (_) {}

  // 1. Play loud SMS alert ringtone
  playSmsChime();

  // 2. Vibrate mobile phone
  triggerVibration();

  // 3. Auto-Copy Code to clipboard
  let copied = false;
  if (settings.autoCopy) {
    copied = await copyToClipboard(otpCode);
  }

  // 4. Show top heads-up banner on phone screen
  showHeadsUpBanner(otpCode, account.email, iconClass || 'fa-solid fa-key');

  // 5. Send native phone push notification (heads-up while on Instagram)
  sendSystemNotification(otpCode, account.email);

  // 6. Toast alert
  if (copied) {
    showToast(`⚡ OTP ${otpCode} Auto-Copied to Clipboard!`, 'success');
  } else {
    showToast(`⚡ New OTP Received: ${otpCode}`, 'success');
  }

  // 7. Record to History
  const historyItem = {
    id: 'hist_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    email: account.email,
    code: otpCode,
    icon: iconClass || 'fa-solid fa-key',
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: new Date().toLocaleDateString(),
    messages: messages || []
  };
  
  history.unshift(historyItem);
  if (history.length > 50) history.pop();

  // 8. Update account state
  account.lastOtp = otpCode;
  account.lastIcon = iconClass;
  account.lastStatus = 'success';
  account.lastCheckedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  saveToStorage();
  renderAccountsList();
  renderHistoryList();
  updateMetrics();
}

// ============================================================================
// BULLETPROOF OTP EXTRACTOR & DECODERS (COMPATIBLE WITH code.yamin.bd)
// ============================================================================
function decodeBase64Utf8(b64) {
  if (!b64) return '';
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
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

function extractOtpAndDetails(result) {
  if (!result) return { code: null, icon: 'fa-solid fa-key', messages: [] };

  let detectedIcon = result.icon || 'fa-solid fa-key';
  let messageList = [];

  // 1. Direct top-level code if valid
  if (result.code && String(result.code).trim() !== '------') {
    const c = String(result.code).trim();
    return { code: c, icon: detectServiceIcon(result.service || result.content, detectedIcon), messages: [] };
  }
  if (result.otp && String(result.otp).trim() !== '------') {
    const c = String(result.otp).trim();
    return { code: c, icon: detectServiceIcon(result.service || result.content, detectedIcon), messages: [] };
  }
  if (result.verification_code) {
    const c = String(result.verification_code).trim();
    return { code: c, icon: detectServiceIcon(result.service || result.content, detectedIcon), messages: [] };
  }
  if (result.data && (result.data.code || result.data.otp)) {
    const c = String(result.data.code || result.data.otp).trim();
    if (c && c !== '------') {
      return { code: c, icon: detectServiceIcon(result.data.service, detectedIcon), messages: [] };
    }
  }

  // 2. Scan messages array (Crucial for Instagram and code.yamin.bd)
  if (Array.isArray(result.messages) && result.messages.length > 0) {
    messageList = result.messages;
    for (const msg of result.messages) {
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
    typeof result.content === 'string' ? result.content : '',
    typeof result.message === 'string' ? result.message : ''
  ].filter(Boolean).join(' ');

  if (textToScan) {
    const extracted = findCodeInText('', textToScan);
    if (extracted) {
      return { code: extracted, icon: detectServiceIcon(textToScan, detectedIcon), messages: messageList };
    }
  }

  return { code: null, icon: detectedIcon, messages: messageList };
}

// ============================================================================
// API CALLER (WITH SMART DEFAULTS & LOCAL PROXY FALLBACK)
// ============================================================================
// ============================================================================
// API CALLER (DIRECT TO code.yamin.bd - ULTRA FAST ~300ms)
// ============================================================================
async function fetchAccountOtp(account) {
  const payload = {
    email: account.email,
    password: account.password || DEFAULT_PASSWORD,
    refresh_token: account.refreshToken,
    client_id: account.clientId || DEFAULT_CLIENT_ID
  };
  if (account.recoveryEmail) {
    payload.recovery_email = account.recoveryEmail;
  }

  // 1. Direct fetch to code.yamin.bd (FASTEST: 200-400ms, no proxy lag)
  try {
    const res = await fetch('https://code.yamin.bd/api.php?action=fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (directErr) {
    // 2. Fallback to local server proxy only if direct network glitch
    try {
      const proxyRes = await fetch('/api/proxy-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000)
      });
      if (proxyRes.ok) {
        return await proxyRes.json();
      }
    } catch (_) {}
    throw new Error('Connection failed: ' + directErr.message);
  }
}

// ============================================================================
// MONITORING LOOP ENGINE
// ============================================================================
function startMonitoring() {
  if (accounts.length === 0) {
    showToast('Please load at least 1 account first!', 'warning');
    openAddModal();
    return;
  }

  // Unlock Audio & Keep-Alive on user interaction
  playSmsChime();
  startBackgroundKeepAlive();
  requestWakeLock();

  settings.isMonitoring = true;
  saveToStorage();
  updateMonitoringUI(true);

  // Sync state with backend server so PC monitors in parallel
  syncWithServerMonitor();

  showToast(`Live Monitoring Started (${accounts.length} accounts)`, 'success');

  // Immediately run first check
  runMonitoringCycle();

  // Background Web Worker (runs in background without freeze)
  if (bgWorker) {
    bgWorker.postMessage({ action: 'start', interval: settings.pollInterval });
  }

  // Standard interval fallback
  if (monitoringInterval) clearInterval(monitoringInterval);
  monitoringInterval = setInterval(runMonitoringCycle, settings.pollInterval);
}

function stopMonitoring() {
  settings.isMonitoring = false;
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  if (bgWorker) {
    bgWorker.postMessage({ action: 'stop' });
  }

  releaseWakeLock();
  stopBackgroundKeepAlive();
  saveToStorage();
  updateMonitoringUI(false);

  // Sync state with server
  syncWithServerMonitor();

  // Set any 'checking' accounts back
  accounts.forEach((acc) => {
    if (acc.lastStatus === 'checking') {
      acc.lastStatus = acc.lastOtp ? 'success' : 'idle';
    }
  });
  renderAccountsList();
  showToast('Live Monitoring Paused', 'info');
}

async function runMonitoringCycle() {
  if (!settings.isMonitoring || isCurrentlyFetching || accounts.length === 0) return;
  
  isCurrentlyFetching = true;
  document.getElementById('metricActive').textContent = accounts.length;

  accounts.forEach((acc) => {
    acc.lastStatus = 'checking';
  });
  renderAccountsList();

  // Check all accounts in parallel for blazing fast ~300ms cycle
  await Promise.all(
    accounts.map(async (account) => {
      try {
        const result = await fetchAccountOtp(account);
        account.lastCheckedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        const { code, icon, messages } = extractOtpAndDetails(result);

        if (code) {
          if (!account.isBaselineDone) {
            // First time checking account: record existing inbox code as baseline snapshot, NEVER alert or show old code
            account.isBaselineDone = true;
            account.lastSeenCode = code;
            account.lastStatus = 'idle';
            account.lastOtp = null;
          } else if (account.lastSeenCode !== code) {
            // A genuine NEW OTP arrived!
            account.lastSeenCode = code;
            await handleNewOtp(account, code, icon, messages);
          } else {
            account.lastStatus = account.lastOtp ? 'success' : 'idle';
          }
        } else {
          account.isBaselineDone = true;
          if (result && result.error) {
            if (result.error_code === 'token_error') {
              account.lastStatus = 'error';
              account.lastError = 'Token Error';
            } else {
              account.lastStatus = account.lastOtp ? 'success' : 'idle';
            }
          } else {
            account.lastStatus = account.lastOtp ? 'success' : 'idle';
          }
        }
      } catch (err) {
        account.lastStatus = account.lastOtp ? 'success' : 'error';
        account.lastError = 'Network error';
      }
    })
  );

  renderAccountsList();
  isCurrentlyFetching = false;
  document.getElementById('metricActive').textContent = '0';
  saveToStorage();
}

// Single Account "Check Now" button
async function checkSingleAccount(accountId) {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;

  account.lastStatus = 'checking';
  renderAccountsList();
  showToast(`Checking ${account.email}...`, 'info');

  try {
    const result = await fetchAccountOtp(account);
    account.lastCheckedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const { code, icon, messages } = extractOtpAndDetails(result);

    if (code) {
      if (!account.isBaselineDone) {
        account.isBaselineDone = true;
        if (account.lastSeenCode && account.lastSeenCode !== code) {
          account.lastSeenCode = code;
          await handleNewOtp(account, code, icon, messages);
        } else {
          account.lastSeenCode = code;
          showToast(`Account calibrated. Inbox has code ${code}. Ready for NEW OTP!`, 'info');
          account.lastStatus = 'idle';
        }
      } else if (account.lastSeenCode !== code) {
        account.lastSeenCode = code;
        await handleNewOtp(account, code, icon, messages);
      } else {
        showToast(`No new OTP (Inbox code ${code} is already checked)`, 'info');
        account.lastStatus = account.lastOtp ? 'success' : 'idle';
      }
    } else {
      account.isBaselineDone = true;
      showToast(result && result.error ? result.error : 'No active OTP in mailbox yet', 'info');
      account.lastStatus = account.lastOtp ? 'success' : 'idle';
      if (result && result.error_code === 'token_error') {
        account.lastStatus = 'error';
        account.lastError = 'Token Error';
      }
    }
  } catch (err) {
    showToast('Failed to check account: ' + err.message, 'error');
    account.lastStatus = 'error';
    account.lastError = 'Network error';
  }

  renderAccountsList();
  saveToStorage();
}

// ============================================================================
// SIMULATION (TEST SOUND, VIBRATION, BANNER & AUTO-COPY)
// ============================================================================
async function runSimulationTest() {
  const sampleServices = [
    { icon: 'fa-brands fa-instagram', name: 'Instagram' },
    { icon: 'fa-brands fa-google', name: 'Google' },
    { icon: 'fa-brands fa-whatsapp', name: 'WhatsApp' },
    { icon: 'fa-brands fa-facebook', name: 'Facebook' },
    { icon: 'fa-brands fa-microsoft', name: 'Microsoft' }
  ];
  
  const chosen = sampleServices[Math.floor(Math.random() * sampleServices.length)];
  const randomOtp = Math.floor(100000 + Math.random() * 900000).toString();
  const testEmail = accounts.length > 0 ? accounts[0].email : 'user_test@hotmail.com';

  const mockAccount = accounts.length > 0 ? accounts[0] : {
    id: 'mock_test',
    email: testEmail,
    lastOtp: null,
    lastSeenCode: null
  };

  await handleNewOtp(mockAccount, randomOtp, chosen.icon, [`Your ${chosen.name} verification code is ${randomOtp}`]);
}

// ============================================================================
// SMART ACCOUNTS PARSER
// (Supports email|token, email|password|token, delimiters ----, :, |, tabs)
// ============================================================================
function parseSingleAccountLine(line) {
  line = line.trim();
  if (!line) return null;

  // Split by common delimiters: ----, |, tab, :, or comma
  let parts;
  if (line.includes('----')) {
    parts = line.split('----');
  } else if (line.includes('\t')) {
    parts = line.split('\t');
  } else if (line.includes('|')) {
    parts = line.split('|');
  } else if (line.includes(':') && !line.startsWith('http')) {
    parts = line.split(':');
  } else if (line.includes(',')) {
    parts = line.split(',');
  } else {
    parts = line.split(/\s+/);
  }

  parts = parts.map((p) => p.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  if (parts.length === 0) return null;

  // Find email part
  const emailIndex = parts.findIndex((p) => p.includes('@') && p.includes('.'));
  if (emailIndex === -1) return null;

  const email = parts[emailIndex];
  const remaining = parts.filter((_, idx) => idx !== emailIndex);

  let password = '';
  let refreshToken = '';
  let clientId = DEFAULT_CLIENT_ID;
  let recoveryEmail = '';

  // 1. Look for UUID client_id (e.g. 1fec8e78-bce4-4aaf-ab1b-5451cc387264)
  const clientIdIndex = remaining.findIndex((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p));
  if (clientIdIndex !== -1) {
    clientId = remaining[clientIdIndex];
    remaining.splice(clientIdIndex, 1);
  }

  // 2. Look for recovery email if present
  const recEmailIndex = remaining.findIndex((p) => p.includes('@') && p.includes('.'));
  if (recEmailIndex !== -1) {
    recoveryEmail = remaining[recEmailIndex];
    remaining.splice(recEmailIndex, 1);
  }

  // 3. Look for OAuth refresh token (starts with 0.A or M.R or long string)
  const tokenIndex = remaining.findIndex((p) => p.startsWith('0.') || p.startsWith('M.') || p.length > 40);
  if (tokenIndex !== -1) {
    refreshToken = remaining[tokenIndex];
    remaining.splice(tokenIndex, 1);
  }

  // 4. Any remaining item can be password
  if (remaining.length > 0) {
    password = remaining[0];
  }

  // 5. If refresh token wasn't identified by prefix, but remaining items exist
  if (!refreshToken && remaining.length > 1) {
    refreshToken = remaining[1];
  } else if (!refreshToken && remaining.length === 1) {
    refreshToken = remaining[0];
    password = DEFAULT_PASSWORD;
  }

  return {
    id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    email,
    password: password || DEFAULT_PASSWORD,
    refreshToken: refreshToken || '',
    clientId: clientId || DEFAULT_CLIENT_ID,
    recoveryEmail: recoveryEmail || '',
    lastStatus: 'idle',
    lastOtp: null,
    lastIcon: null,
    lastCheckedTime: null,
    lastError: null,
    lastSeenCode: null,
    isBaselineDone: false
  };
}

function parseAccountsInput(rawText) {
  const lines = rawText.split('\n');
  const parsed = [];

  for (const line of lines) {
    const acc = parseSingleAccountLine(line);
    if (acc) parsed.push(acc);
  }

  return parsed;
}

function addSampleAccounts() {
  // Demo accounts removed for clean production experience
}

function updateDetectedCount() {
  const rawText = document.getElementById('bulkAccountsInput').value;
  const parsed = parseAccountsInput(rawText);
  document.getElementById('detectedCountText').textContent = `${parsed.length} accounts detected`;
}

function saveBulkAccounts() {
  const rawText = document.getElementById('bulkAccountsInput').value;
  const newAccounts = parseAccountsInput(rawText);

  if (newAccounts.length === 0) {
    showToast('No valid accounts found in input', 'warning');
    return;
  }

  // Deduplicate against existing emails
  const existingEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
  let addedCount = 0;

  for (const acc of newAccounts) {
    if (!existingEmails.has(acc.email.toLowerCase())) {
      accounts.push(acc);
      existingEmails.add(acc.email.toLowerCase());
      addedCount++;
    }
  }

  saveToStorage();
  syncWithServerMonitor();
  renderAccountsList();
  updateMetrics();
  closeAddModal();

  showToast(`Added ${addedCount} accounts! Starting Live Monitor...`, 'success');

  // Immediately start live monitoring so incoming OTPs are never missed
  startMonitoring();
}

function deleteAccount(accountId) {
  accounts = accounts.filter((a) => a.id !== accountId);
  saveToStorage();
  syncWithServerMonitor();
  renderAccountsList();
  updateMetrics();
  showToast('Account removed', 'info');
}

function clearAllAccounts() {
  if (accounts.length === 0) return;
  if (confirm('Are you sure you want to clear all loaded accounts?')) {
    if (settings.isMonitoring) stopMonitoring();
    accounts = [];
    saveToStorage();
    syncWithServerMonitor();
    renderAccountsList();
    updateMetrics();
    showToast('All accounts cleared', 'info');
  }
}

function clearHistory() {
  if (history.length === 0) return;
  history = [];
  saveToStorage();
  renderHistoryList();
  updateMetrics();
  showToast('History cleared', 'info');
}

// ============================================================================
// UI RENDERING
// ============================================================================
function renderAccountsList() {
  const container = document.getElementById('accountsList');
  const emptyState = document.getElementById('emptyState');

  if (accounts.length === 0) {
    container.innerHTML = '';
    container.appendChild(emptyState);
    emptyState.style.display = 'flex';
    document.getElementById('accountCountBadge').textContent = '0';
    return;
  }

  emptyState.style.display = 'none';
  document.getElementById('accountCountBadge').textContent = accounts.length.toString();

  container.innerHTML = accounts.map((acc, index) => {
    const isChecking = acc.lastStatus === 'checking';
    const hasOtp = !!acc.lastOtp;
    const isError = acc.lastStatus === 'error';
    
    let statusClass = 'idle';
    let statusText = 'Ready';
    let statusIcon = 'fa-regular fa-clock';

    if (isChecking) {
      statusClass = 'checking';
      statusText = 'Checking...';
      statusIcon = 'fa-solid fa-spinner fa-spin';
    } else if (hasOtp) {
      statusClass = 'success';
      statusText = 'OTP Captured';
      statusIcon = 'fa-solid fa-check-double';
    } else if (isError) {
      statusClass = 'error';
      statusText = acc.lastError || 'Error';
      statusIcon = 'fa-solid fa-triangle-exclamation';
    }

    const serviceIcon = acc.lastIcon || 'fa-brands fa-microsoft';

    return `
      <div class="account-card ${hasOtp ? 'has-otp' : ''}" id="acc_card_${acc.id}">
        <div class="account-card-header">
          <div class="account-email-wrap">
            <div class="account-service-icon">
              <i class="${serviceIcon}"></i>
            </div>
            <div>
              <div class="account-email-text" title="${escapeHtml(acc.email)}">${escapeHtml(acc.email)}</div>
              ${acc.recoveryEmail ? `<div style="font-size: 0.7rem; color: var(--text-dim);"><i class="fa-solid fa-shield-cat"></i> ${escapeHtml(acc.recoveryEmail)}</div>` : ''}
            </div>
          </div>
          <div class="account-status-chip ${statusClass}">
            <i class="${statusIcon}"></i>
            <span>${statusText}</span>
          </div>
        </div>

        ${hasOtp ? `
          <div class="otp-display-box">
            <div class="otp-code-glow">
              <i class="${serviceIcon}" style="font-size: 1.1rem; color: var(--accent-cyan);"></i>
              <span style="font-size: 0.78rem; color: var(--text-muted); font-weight: 600;">OTP:</span>
              <span class="otp-code-number">${escapeHtml(acc.lastOtp)}</span>
            </div>
            <button class="copy-otp-btn" onclick="copyAccountCode('${escapeHtml(acc.lastOtp)}')">
              <i class="fa-regular fa-copy"></i> Copy
            </button>
          </div>
        ` : ''}

        <div class="account-card-footer">
          <span class="checked-time">
            ${acc.lastCheckedTime ? `Checked: ${acc.lastCheckedTime}` : 'Not checked yet'}
          </span>
          <div class="card-action-btns">
            <button class="card-action-btn" title="Check OTP Now" onclick="checkSingleAccount('${acc.id}')">
              <i class="fa-solid fa-rotate ${isChecking ? 'fa-spin' : ''}"></i> Check
            </button>
            <button class="card-action-btn delete" title="Delete Account" onclick="deleteAccount('${acc.id}')">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderHistoryList() {
  const container = document.getElementById('historyList');
  const emptyState = document.getElementById('historyEmptyState');

  if (history.length === 0) {
    container.innerHTML = '';
    container.appendChild(emptyState);
    emptyState.style.display = 'flex';
    document.getElementById('historyCountBadge').textContent = '0';
    return;
  }

  emptyState.style.display = 'none';
  document.getElementById('historyCountBadge').textContent = history.length.toString();

  container.innerHTML = history.map((item) => `
    <div class="history-item">
      <div class="history-icon-box">
        <i class="${item.icon || 'fa-solid fa-key'}"></i>
      </div>
      <div class="history-details">
        <div class="history-email">${escapeHtml(item.email)}</div>
        <div class="history-time"><i class="fa-regular fa-clock"></i> ${item.time} (${item.date || 'Today'})</div>
      </div>
      <div class="history-otp-wrap">
        <span class="history-code">${escapeHtml(item.code)}</span>
        <button class="copy-otp-btn" style="padding: 4px 8px; font-size: 0.72rem;" onclick="copyAccountCode('${escapeHtml(item.code)}')">
          <i class="fa-regular fa-copy"></i>
        </button>
      </div>
    </div>
  `).join('');
}

function updateMetrics() {
  document.getElementById('metricTotal').textContent = accounts.length.toString();
  document.getElementById('metricCaptured').textContent = history.length.toString();
}

function updateMonitoringUI(isActive) {
  const btn = document.getElementById('startMonitorBtn');
  const btnIcon = document.getElementById('startBtnIcon');
  const btnText = document.getElementById('startBtnText');
  const dot = document.getElementById('pulseDot');
  const statusText = document.getElementById('monitorStatusText');

  if (isActive) {
    btn.classList.add('running');
    btnIcon.className = 'fa-solid fa-pause';
    btnText.textContent = 'PAUSE LIVE MONITORING';
    dot.classList.add('active');
    statusText.textContent = `Monitoring ${accounts.length} Accounts Active`;
  } else {
    btn.classList.remove('running');
    btnIcon.className = 'fa-solid fa-play';
    btnText.textContent = 'START LIVE MONITORING';
    dot.classList.remove('active');
    statusText.textContent = 'Ready to Monitor';
  }
}

function applySettingsToUI() {
  updateToggleUI('toggleAutoCopy', settings.autoCopy);
  updateToggleUI('toggleSound', settings.soundAlert);
  updateToggleUI('toggleVibrate', settings.vibrate);
  updateToggleUI('toggleSystemNotif', settings.systemNotif);

  const soundBtn = document.getElementById('soundHeaderBtn');
  const soundIcon = document.getElementById('soundHeaderIcon');
  if (soundBtn && soundIcon) {
    if (settings.soundAlert) {
      soundBtn.classList.add('active');
      soundIcon.className = 'fa-solid fa-volume-high';
    } else {
      soundBtn.classList.remove('active');
      soundIcon.className = 'fa-solid fa-volume-xmark';
    }
  }

  const intervalSelect = document.getElementById('intervalSelect');
  if (intervalSelect) {
    intervalSelect.value = settings.pollInterval.toString();
  }
}

function updateToggleUI(elementId, isActive) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (isActive) {
    el.classList.add('active');
  } else {
    el.classList.remove('active');
  }
}

// ============================================================================
// API STATUS CHECK
// ============================================================================
async function checkApiHealth() {
  const badge = document.getElementById('apiBadge');
  try {
    const res = await fetch('https://code.yamin.bd/api.php?action=status', {
      signal: AbortSignal.timeout(6000)
    });
    const data = await res.json();
    if (data.status) {
      badge.className = 'api-badge online';
      badge.innerHTML = `<i class="fa-solid fa-signal"></i><span>API Online</span>`;
    } else {
      badge.className = 'api-badge';
      badge.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i><span>API Warning</span>`;
    }
  } catch (e) {
    badge.className = 'api-badge';
    badge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i><span>API Offline</span>`;
  }
}

// Fetch network URL & QR code from server
async function fetchNetworkInfo() {
  try {
    const res = await fetch('/api/network-info');
    if (!res.ok) return;
    const data = await res.json();
    
    document.getElementById('qrImage').src = data.qrDataUrl;
    document.getElementById('phoneUrlText').textContent = data.fullUrl;
    
    document.getElementById('copyUrlBtn').onclick = () => {
      copyToClipboard(data.fullUrl);
      showToast('Phone URL copied to clipboard!', 'success');
    };
  } catch (err) {
    console.log('Local network endpoint not reachable:', err.message);
  }
}

// ============================================================================
// MODAL CONTROLS
// ============================================================================
function openAddModal() {
  document.getElementById('addAccountsModal').classList.add('active');
  document.getElementById('bulkAccountsInput').focus();
}

function closeAddModal() {
  document.getElementById('addAccountsModal').classList.remove('active');
}

function openQrModal() {
  document.getElementById('qrModal').classList.add('active');
}

function closeQrModal() {
  document.getElementById('qrModal').classList.remove('active');
}

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'fa-solid fa-info-circle';
  if (type === 'success') icon = 'fa-solid fa-circle-check';
  if (type === 'warning') icon = 'fa-solid fa-triangle-exclamation';
  if (type === 'error') icon = 'fa-solid fa-circle-xmark';

  toast.innerHTML = `<i class="${icon}"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// Global helpers for inline buttons
window.copyAccountCode = function(code) {
  copyToClipboard(code);
  showToast(`Copied: ${code}`, 'success');
};

window.checkSingleAccount = checkSingleAccount;
window.deleteAccount = deleteAccount;

// ============================================================================
// DOM EVENT LISTENERS
// ============================================================================
function initDomEvents() {
  // Main Start/Stop button
  document.getElementById('startMonitorBtn').addEventListener('click', () => {
    if (settings.isMonitoring) {
      stopMonitoring();
    } else {
      startMonitoring();
    }
  });

  // Header permissions button
  document.getElementById('permissionHeaderBtn').addEventListener('click', openPermissionModal);
  document.getElementById('closePermissionModalBtn').addEventListener('click', closePermissionModal);
  document.getElementById('skipPermissionBtn').addEventListener('click', closePermissionModal);
  document.getElementById('grantAllPermissionsBtn').addEventListener('click', grantAllPermissions);

  // Wake Lock modal
  document.getElementById('closeWakeLockModalBtn').addEventListener('click', closeWakeLockModal);
  document.getElementById('gotItWakeLockBtn').addEventListener('click', closeWakeLockModal);

  // Toggles
  document.getElementById('toggleAutoCopy').addEventListener('click', () => {
    settings.autoCopy = !settings.autoCopy;
    updateToggleUI('toggleAutoCopy', settings.autoCopy);
    saveToStorage();
    showToast(`Auto-Copy: ${settings.autoCopy ? 'Enabled' : 'Disabled'}`, 'info');
  });

  document.getElementById('toggleSound').addEventListener('click', () => {
    settings.soundAlert = !settings.soundAlert;
    updateToggleUI('toggleSound', settings.soundAlert);
    applySettingsToUI();
    saveToStorage();
    if (settings.soundAlert) playSmsChime();
  });

  document.getElementById('soundHeaderBtn').addEventListener('click', () => {
    settings.soundAlert = !settings.soundAlert;
    applySettingsToUI();
    saveToStorage();
    if (settings.soundAlert) playSmsChime();
  });

  document.getElementById('toggleVibrate').addEventListener('click', () => {
    settings.vibrate = !settings.vibrate;
    updateToggleUI('toggleVibrate', settings.vibrate);
    saveToStorage();
    if (settings.vibrate) triggerVibration();
  });

  document.getElementById('toggleSystemNotif').addEventListener('click', async () => {
    settings.systemNotif = !settings.systemNotif;
    updateToggleUI('toggleSystemNotif', settings.systemNotif);
    saveToStorage();
    if (settings.systemNotif && 'Notification' in window && Notification.permission !== 'granted') {
      await Notification.requestPermission();
      updatePermissionBadges();
    }
  });

  // Wake lock header button (toggles or shows explanation)
  document.getElementById('wakeLockBtn').addEventListener('click', async () => {
    if (wakeLockSentinel) {
      releaseWakeLock();
      showToast('Screen Wake Lock বন্ধ করা হয়েছে', 'info');
    } else {
      const success = await requestWakeLock();
      if (success) {
        showToast('Screen Wake Lock সক্রিয়: ফোনের ডিসপ্লে স্লিপ হবে না', 'success');
      } else {
        openWakeLockModal();
      }
    }
    updatePermissionBadges();
  });

  // Interval change
  document.getElementById('intervalSelect').addEventListener('change', (e) => {
    settings.pollInterval = parseInt(e.target.value, 10);
    saveToStorage();
    syncWithServerMonitor();
    showToast(`Poll Interval set to ${settings.pollInterval / 1000}s`, 'info');
    if (settings.isMonitoring) {
      if (monitoringInterval) clearInterval(monitoringInterval);
      monitoringInterval = setInterval(runMonitoringCycle, settings.pollInterval);
      if (bgWorker) bgWorker.postMessage({ action: 'start', interval: settings.pollInterval });
    }
  });

  // Simulation button
  document.getElementById('simulateOtpBtn').addEventListener('click', () => {
    runSimulationTest();
  });

  // Modal Triggers
  document.getElementById('openAddModalBtn').addEventListener('click', openAddModal);
  document.getElementById('emptyLoadBtn').addEventListener('click', openAddModal);
  document.getElementById('closeAddModalBtn').addEventListener('click', closeAddModal);
  document.getElementById('cancelAddBtn').addEventListener('click', closeAddModal);

  document.getElementById('phoneConnectBtn').addEventListener('click', openQrModal);
  document.getElementById('closeQrModalBtn').addEventListener('click', closeQrModal);
  document.getElementById('closeQrFooterBtn').addEventListener('click', closeQrModal);

  // Bulk Input Live Counter
  document.getElementById('bulkAccountsInput').addEventListener('input', updateDetectedCount);
  const sampleBtn = document.getElementById('loadSampleAccountsBtn');
  if (sampleBtn) sampleBtn.addEventListener('click', addSampleAccounts);
  document.getElementById('saveAccountsBtn').addEventListener('click', saveBulkAccounts);

  // Clear buttons
  document.getElementById('clearAllBtn').addEventListener('click', clearAllAccounts);
  document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);

  // Close Banner Button
  document.getElementById('bannerCloseBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    hideHeadsUpBanner();
  });

  // Bottom Navigation tabs
  const navAccounts = document.getElementById('navAccounts');
  const navHistory = document.getElementById('navHistory');
  const navPhone = document.getElementById('navPhone');
  const accountsSection = document.getElementById('accountsSection');
  const historySection = document.getElementById('historySection');

  navAccounts.addEventListener('click', () => {
    navAccounts.classList.add('active');
    navHistory.classList.remove('active');
    accountsSection.style.display = 'block';
    historySection.style.display = 'none';
  });

  navHistory.addEventListener('click', () => {
    navHistory.classList.add('active');
    navAccounts.classList.remove('active');
    accountsSection.style.display = 'none';
    historySection.style.display = 'block';
  });

  navPhone.addEventListener('click', openQrModal);
}

// Utility: escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
