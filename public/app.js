/**
 * MailCode OTP Grabber & Auto-Copy App
 * Real-time Hotmail/Outlook OTP monitoring with heads-up SMS notification banner and auto-copy.
 */

// ============================================================================
// APPLICATION STATE & STORAGE
// ============================================================================
const STORAGE_KEY_ACCOUNTS = 'mailcode_accounts_v1';
const STORAGE_KEY_SETTINGS = 'mailcode_settings_v1';
const STORAGE_KEY_HISTORY = 'mailcode_history_v1';

let accounts = [];
let history = [];
let settings = {
  autoCopy: true,
  soundAlert: true,
  vibrate: true,
  systemNotif: true,
  pollInterval: 5000,
  isMonitoring: false
};

let monitoringInterval = null;
let currentCheckingIndex = 0;
let isCurrentlyFetching = false;
let wakeLockSentinel = null;
let audioContext = null;
let bannerTimeout = null;

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  initServiceWorker();
  initDomEvents();
  renderAccountsList();
  renderHistoryList();
  updateMetrics();
  checkApiHealth();
  fetchNetworkInfo();
});

// Load saved data
function loadFromStorage() {
  try {
    const savedAccounts = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
    if (savedAccounts) accounts = JSON.parse(savedAccounts);
    
    const savedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (savedSettings) {
      settings = { ...settings, ...JSON.parse(savedSettings) };
      // Always reset monitoring to false on initial page load
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
  }
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
    
    gain1.gain.setValueAtTime(0.5, now);
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
    gain2.gain.setValueAtTime(0.6, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
    
    osc2.connect(gain2);
    gain2.connect(audioContext.destination);
    
    osc2.start(now + 0.1);
    osc2.stop(now + 0.65);
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
      // Standard smartphone double pulse vibration
      navigator.vibrate([120, 80, 150, 80, 200]);
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
    console.error('Clipboard copy error:', err);
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
    } catch (err) {
      console.log('WakeLock not granted or supported:', err.message);
      updateWakeLockUI(false);
    }
  }
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
  if (isActive) {
    btn.classList.add('active');
    icon.style.color = '#f59e0b';
    btn.title = 'Screen Wake Lock: Active (Screen will not sleep)';
  } else {
    btn.classList.remove('active');
    icon.style.color = '';
    btn.title = 'Screen Wake Lock: Inactive';
  }
}

// Re-acquire wake lock if page becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && settings.isMonitoring) {
    requestWakeLock();
  }
});

// ============================================================================
// TOP HEADS-UP SMS NOTIFICATION BANNER
// ============================================================================
function showHeadsUpBanner(otpCode, email, iconClass, serviceName) {
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

// Request System Notification Permission
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendSystemNotification(code, email, serviceName) {
  if (!settings.systemNotif || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    try {
      const options = {
        body: `New OTP for ${email}: ${code}\nAutomatically copied to clipboard!`,
        icon: '/icons/icon-192.svg',
        badge: '/icons/icon-192.svg',
        tag: 'otp-' + Date.now(),
        data: { code: code }
      };
      
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(`⚡ OTP Code: ${code}`, options);
        });
      } else {
        new Notification(`⚡ OTP Code: ${code}`, options);
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
  console.log(`🚀 [NEW OTP] ${account.email} => ${otpCode}`);

  // 1. Play SMS alert ringtone
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

  // 5. Send native push notification
  sendSystemNotification(otpCode, account.email, 'MailCode');

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
  if (history.length > 50) history.pop(); // keep last 50

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
// API CALLER (WITH DIRECT CORS & FALLBACK LOCAL PROXY)
// ============================================================================
async function fetchAccountOtp(account) {
  const payload = {
    email: account.email,
    password: account.password,
    refresh_token: account.refreshToken,
    client_id: account.clientId
  };
  if (account.recoveryEmail) {
    payload.recovery_email = account.recoveryEmail;
  }

  // Try direct fetch first
  try {
    const res = await fetch('https://code.yamin.bd/api.php?action=fetch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json();
    return data;
  } catch (directErr) {
    console.warn(`Direct fetch failed for ${account.email}, trying local proxy:`, directErr.message);
    // Try fallback proxy if local server is running
    try {
      const proxyRes = await fetch('/api/proxy-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000)
      });
      return await proxyRes.json();
    } catch (proxyErr) {
      throw new Error(proxyErr.message || directErr.message);
    }
  }
}

// ============================================================================
// MONITORING LOOP ENGINE ("RUNNING TIME E JETAY KAJ HOBE")
// ============================================================================
function startMonitoring() {
  if (accounts.length === 0) {
    showToast('Please load at least 1 account first!', 'warning');
    openAddModal();
    return;
  }

  // Unlock AudioContext on user interaction
  playSmsChime();
  requestWakeLock();
  requestNotificationPermission();

  settings.isMonitoring = true;
  saveToStorage();
  updateMonitoringUI(true);

  showToast(`Live Monitoring Started (${accounts.length} accounts)`, 'success');

  // Immediately run first check
  runMonitoringCycle();

  // Schedule recurring checks
  if (monitoringInterval) clearInterval(monitoringInterval);
  monitoringInterval = setInterval(runMonitoringCycle, settings.pollInterval);
}

function stopMonitoring() {
  settings.isMonitoring = false;
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  releaseWakeLock();
  saveToStorage();
  updateMonitoringUI(false);

  // Set any 'checking' accounts back to their previous state
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

  // We check 2 accounts concurrently for speed and reliability without getting banned
  const batchSize = Math.min(2, accounts.length);
  
  for (let b = 0; b < accounts.length; b += batchSize) {
    if (!settings.isMonitoring) break;
    
    const currentBatch = accounts.slice(b, b + batchSize);
    
    // Mark batch as checking
    currentBatch.forEach((acc) => {
      acc.lastStatus = 'checking';
    });
    renderAccountsList();

    // Execute batch
    await Promise.all(
      currentBatch.map(async (account) => {
        try {
          const result = await fetchAccountOtp(account);
          account.lastCheckedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          
          if (result && result.status === true && result.code) {
            const newCode = String(result.code).trim();
            const icon = result.icon || 'fa-solid fa-envelope-open-text';

            // Check if this is a fresh new OTP code that we haven't processed yet
            if (account.lastSeenCode !== newCode) {
              account.lastSeenCode = newCode;
              await handleNewOtp(account, newCode, icon, result.messages);
            } else {
              // Same code as before - update status without repeat loud sound/auto-copy
              account.lastStatus = 'success';
              account.lastOtp = newCode;
              account.lastIcon = icon;
            }
          } else {
            // Status false or no code yet
            if (result && result.error) {
              // Token error or other API message
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
          console.error(`Error checking ${account.email}:`, err.message);
          account.lastStatus = account.lastOtp ? 'success' : 'error';
          account.lastError = 'Network error';
        }
      })
    );

    renderAccountsList();
  }

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

    if (result && result.status === true && result.code) {
      const code = String(result.code).trim();
      const icon = result.icon || 'fa-solid fa-key';
      account.lastSeenCode = code;
      await handleNewOtp(account, code, icon, result.messages);
    } else {
      showToast(result.error || 'No active OTP found in mailbox yet', 'info');
      account.lastStatus = account.lastOtp ? 'success' : 'idle';
      if (result.error_code === 'token_error') {
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
    { icon: 'fa-brands fa-google', name: 'Google' },
    { icon: 'fa-brands fa-microsoft', name: 'Microsoft' },
    { icon: 'fa-brands fa-whatsapp', name: 'WhatsApp' },
    { icon: 'fa-brands fa-facebook', name: 'Facebook' },
    { icon: 'fa-brands fa-telegram', name: 'Telegram' }
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
// ACCOUNTS MANAGEMENT & BULK PARSER
// ============================================================================
function parseAccountsInput(rawText) {
  const lines = rawText.split('\n');
  const parsed = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Format: email|password|token|client_id|recovery_email
    const parts = line.split('|');
    if (parts.length >= 2) {
      const email = parts[0].trim();
      const password = parts[1] ? parts[1].trim() : '';
      const refreshToken = parts[2] ? parts[2].trim() : '';
      const clientId = parts[3] ? parts[3].trim() : '';
      const recoveryEmail = parts[4] ? parts[4].trim() : '';

      if (email.includes('@')) {
        parsed.push({
          id: 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          email,
          password,
          refreshToken,
          clientId,
          recoveryEmail,
          lastStatus: 'idle',
          lastOtp: null,
          lastIcon: null,
          lastCheckedTime: null,
          lastError: null,
          lastSeenCode: null
        });
      }
    }
  }

  return parsed;
}

function addSampleAccounts() {
  const sampleText = [
    'john.worker01@hotmail.com|Pass1234!|0.AX4Aw5...sample_token_1|1fec8e78-bce4-4aaf-ab1b-5451cc387264',
    'sarah.leads99@outlook.com|Secret9988!|0.AX4Aw5...sample_token_2|1fec8e78-bce4-4aaf-ab1b-5451cc387264|rec_sarah@gmail.com',
    'david.task2026@hotmail.com|MyPass77#|0.AX4Aw5...sample_token_3|1fec8e78-bce4-4aaf-ab1b-5451cc387264',
    'alexa.verify@live.com|Alpha2026!|0.AX4Aw5...sample_token_4|1fec8e78-bce4-4aaf-ab1b-5451cc387264',
    'mark.hotmail.ops@hotmail.com|P@ssw0rd2026|0.AX4Aw5...sample_token_5|1fec8e78-bce4-4aaf-ab1b-5451cc387264|mark_recovery@gmail.com'
  ].join('\n');

  const textarea = document.getElementById('bulkAccountsInput');
  textarea.value = sampleText;
  updateDetectedCount();
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
  renderAccountsList();
  updateMetrics();
  closeAddModal();

  showToast(`Successfully added ${addedCount} accounts!`, 'success');
}

function deleteAccount(accountId) {
  accounts = accounts.filter((a) => a.id !== accountId);
  saveToStorage();
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

    return `
      <div class="account-card ${isChecking ? 'checking' : ''} ${hasOtp ? 'has-otp' : ''}" id="card_${acc.id}">
        <div class="account-header-row">
          <div class="account-email-wrap">
            <div class="account-type-icon">
              <i class="${acc.lastIcon || 'fa-brands fa-microsoft'}"></i>
            </div>
            <div class="account-email-text" title="${acc.email}">
              ${escapeHtml(acc.email)}
            </div>
          </div>
          <div class="account-status-badge ${statusClass}">
            <i class="${statusIcon}"></i>
            <span>${statusText}</span>
          </div>
        </div>

        ${hasOtp ? `
          <div class="account-otp-box">
            <div class="otp-left">
              <span class="otp-service-tag">
                <i class="${acc.lastIcon || 'fa-solid fa-key'}"></i> OTP:
              </span>
              <span class="otp-number">${escapeHtml(acc.lastOtp)}</span>
            </div>
            <button class="copy-mini-btn" onclick="copyAccountCode('${escapeHtml(acc.lastOtp)}')">
              <i class="fa-regular fa-copy"></i> Copy
            </button>
          </div>
        ` : ''}

        <div class="account-footer-row">
          <span>
            ${acc.lastCheckedTime ? `Checked: ${acc.lastCheckedTime}` : 'Not checked yet'}
          </span>
          <div class="account-actions">
            <button class="text-btn" onclick="checkSingleAccount('${acc.id}')" title="Check this account now">
              <i class="fa-solid fa-arrows-rotate"></i> Check
            </button>
            <button class="text-btn danger" onclick="deleteAccount('${acc.id}')" title="Remove account">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderHistoryList() {
  const container = document.getElementById('historyList');
  document.getElementById('historyCountBadge').textContent = history.length.toString();

  if (history.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 24px;">
        <i class="fa-solid fa-clock-rotate-left" style="font-size: 1.8rem; color: var(--text-dim);"></i>
        <div class="empty-title">No OTPs Captured Yet</div>
        <div class="empty-desc">Captured OTPs will be listed here with timestamps and one-click copy.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = history.map((item) => {
    return `
      <div class="history-card">
        <div class="history-details">
          <div class="history-service-icon">
            <i class="${item.icon || 'fa-solid fa-key'}"></i>
          </div>
          <div class="history-text-col">
            <div class="history-otp-line">
              <span class="history-code">${escapeHtml(item.code)}</span>
              <span class="history-time">${escapeHtml(item.time)}</span>
            </div>
            <div class="history-email">${escapeHtml(item.email)}</div>
          </div>
        </div>
        <button class="copy-mini-btn" onclick="copyAccountCode('${escapeHtml(item.code)}')">
          <i class="fa-regular fa-copy"></i> Copy
        </button>
      </div>
    `;
  }).join('');
}

function updateMetrics() {
  document.getElementById('metricAccounts').textContent = accounts.length.toString();
  document.getElementById('metricOtps').textContent = history.length.toString();
}

function updateMonitoringUI(isRunning) {
  const pulseDot = document.getElementById('pulseDot');
  const statusText = document.getElementById('monitorStatusText');
  const startBtn = document.getElementById('startMonitorBtn');
  const startBtnIcon = document.getElementById('startBtnIcon');
  const startBtnText = document.getElementById('startBtnText');

  if (isRunning) {
    pulseDot.classList.add('running');
    statusText.textContent = `Monitoring ${accounts.length} Accounts Active`;
    statusText.style.color = '#10b981';
    
    startBtn.classList.add('running');
    startBtnIcon.className = 'fa-solid fa-pause';
    startBtnText.textContent = 'STOP MONITORING';
  } else {
    pulseDot.classList.remove('running');
    statusText.textContent = 'Ready to Monitor';
    statusText.style.color = '';
    
    startBtn.classList.remove('running');
    startBtnIcon.className = 'fa-solid fa-play';
    startBtnText.textContent = 'START LIVE MONITORING';
  }
}

function applySettingsToUI() {
  updateToggleUI('toggleAutoCopy', settings.autoCopy);
  updateToggleUI('toggleSound', settings.soundAlert);
  updateToggleUI('toggleVibrate', settings.vibrate);
  updateToggleUI('toggleSystemNotif', settings.systemNotif);

  document.getElementById('intervalSelect').value = settings.pollInterval.toString();
  
  // Sound button in header
  const soundHeaderBtn = document.getElementById('soundHeaderBtn');
  const soundHeaderIcon = document.getElementById('soundHeaderIcon');
  if (settings.soundAlert) {
    soundHeaderBtn.classList.add('active');
    soundHeaderIcon.className = 'fa-solid fa-volume-high';
  } else {
    soundHeaderBtn.classList.remove('active');
    soundHeaderIcon.className = 'fa-solid fa-volume-xmark';
  }
}

function updateToggleUI(elementId, isActive) {
  const el = document.getElementById(elementId);
  if (el) {
    if (isActive) el.classList.add('active');
    else el.classList.remove('active');
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
    
    // Copy URL handler
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

// Global helper for card copy buttons
window.copyAccountCode = function(code) {
  copyToClipboard(code);
  showToast(`Copied: ${code}`, 'success');
};

// Global helper for card check buttons
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
    if (settings.systemNotif) {
      await requestNotificationPermission();
    }
  });

  // Wake lock toggle
  document.getElementById('wakeLockBtn').addEventListener('click', () => {
    if (wakeLockSentinel) {
      releaseWakeLock();
      showToast('Screen Wake Lock disabled', 'info');
    } else {
      requestWakeLock();
      showToast('Screen Wake Lock enabled (screen won’t sleep)', 'success');
    }
  });

  // Interval change
  document.getElementById('intervalSelect').addEventListener('change', (e) => {
    settings.pollInterval = parseInt(e.target.value, 10);
    saveToStorage();
    showToast(`Poll Interval set to ${settings.pollInterval / 1000}s`, 'info');
    if (settings.isMonitoring) {
      if (monitoringInterval) clearInterval(monitoringInterval);
      monitoringInterval = setInterval(runMonitoringCycle, settings.pollInterval);
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
  document.getElementById('loadSampleAccountsBtn').addEventListener('click', addSampleAccounts);
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
