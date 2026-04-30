// ─── State ────────────────────────────────────────────────────
const state = {
  channel:       '',
  youtubeId:     '',
  adActive:      false,
  countdownSecs: null,
  countdownTimer:null,
  _swapped:      false,
};

// ─── YouTube ID extractor ─────────────────────────────────────
function extractYouTubeId(url) {
  url = url.trim();
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── Setup ────────────────────────────────────────────────────
function startWatching() {
  const channelVal = document.getElementById('twitchInput').value.trim().toLowerCase();
  const ytVal      = document.getElementById('youtubeInput').value.trim();

  // Validate Twitch channel
  if (!channelVal) {
    shake('twitchInput');
    return;
  }

  // Parse YouTube URL if provided
  let ytId = null;
  if (ytVal) {
    ytId = extractYouTubeId(ytVal);
    if (!ytId) {
      shake('youtubeInput');
      return;
    }
  }

  state.channel   = channelVal;
  state.youtubeId = ytId || '';

  // Build Twitch embed URL
  const twitchUrl = `https://player.twitch.tv/?channel=${encodeURIComponent(channelVal)}&parent=${location.hostname}&autoplay=true`;
  document.getElementById('twitchFrame').src = twitchUrl;

  // Pre-load YouTube iframe (hidden, paused) if a video was provided
  if (ytId) {
    document.getElementById('youtubeFrame').src =
      `https://www.youtube.com/embed/${ytId}?enablejsapi=1&autoplay=0`;
  }

  // Update channel label
  document.getElementById('watchChannel').textContent = channelVal;

  // Switch screens
  document.getElementById('setupScreen').style.display = 'none';
  document.getElementById('watchScreen').style.display = 'block';

  // Listen for extension messages
  window.addEventListener('message', onMessage);
}

function shake(inputId) {
  const el = document.getElementById(inputId);
  el.classList.add('error');
  el.animate([
    { transform: 'translateX(0)' },
    { transform: 'translateX(-6px)' },
    { transform: 'translateX(6px)' },
    { transform: 'translateX(-4px)' },
    { transform: 'translateX(4px)' },
    { transform: 'translateX(0)' },
  ], { duration: 320, easing: 'ease-out' });
  setTimeout(() => el.classList.remove('error'), 2000);
}

function goBack() {
  // Stop everything and return to setup
  clearCountdown();
  document.getElementById('twitchFrame').src = 'about:blank';
  document.getElementById('youtubeFrame').src = 'about:blank';
  hideYouTube(false);
  window.removeEventListener('message', onMessage);
  state.adActive = false;
  state._swapped = false;
  document.getElementById('setupScreen').style.display = 'flex';
  document.getElementById('watchScreen').style.display = 'none';
}

// ─── Message handler ──────────────────────────────────────────
function onMessage(e) {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.source !== 'bettercommercials-extension' &&
      e.data.source !== 'gridview-extension') return;
  if (e.data.type !== 'vg-ad') return;

  // Verify it's for our channel
  const ch = (e.data.channel || '').toLowerCase().trim();
  if (ch && ch !== state.channel) return;

  handleAd(!!e.data.active, e.data.duration || null);
}

// ─── Ad handling ──────────────────────────────────────────────
function handleAd(isAd, duration) {
  if (state.adActive === isAd) {
    // Already in this state — only update countdown if we get a fresh duration
    if (isAd && duration) {
      startCountdown(duration);
    }
    return;
  }

  state.adActive = isAd;

  if (isAd) {
    showYouTube();
    if (duration) startCountdown(duration);
  } else {
    returnToTwitch();
  }
}

// ─── Show YouTube overlay ─────────────────────────────────────
function showYouTube() {
  if (!state.youtubeId) return; // no YouTube video configured — just wait out the ad
  state._swapped = true;
  const overlay = document.getElementById('ytOverlay');
  overlay.classList.add('visible');
  // Play YouTube
  ytCommand('playVideo');
  // Hide returning label
  document.getElementById('ytReturning').style.display = 'none';
}

// ─── Return to Twitch ─────────────────────────────────────────
function returnToTwitch() {
  if (!state._swapped) return;

  // Show "returning" label briefly
  const returning = document.getElementById('ytReturning');
  returning.style.display = 'block';

  setTimeout(() => {
    // Pause YouTube
    ytCommand('pauseVideo');
    // Fade out overlay
    hideYouTube(true);
    state._swapped = false;
    clearCountdown();
  }, 1000);
}

function hideYouTube(animate) {
  const overlay = document.getElementById('ytOverlay');
  if (animate) {
    overlay.style.transition = 'opacity 0.6s ease';
  }
  overlay.classList.remove('visible');
  document.getElementById('ytReturning').style.display = 'none';
  document.getElementById('ytCountdown').textContent = '';
}

// ─── YouTube postMessage API ──────────────────────────────────
function ytCommand(func) {
  try {
    document.getElementById('youtubeFrame').contentWindow.postMessage(
      JSON.stringify({ event: 'command', func, args: [] }), '*'
    );
  } catch (_) {}
}

// ─── Countdown ────────────────────────────────────────────────
function startCountdown(seconds) {
  clearCountdown();
  state.countdownSecs = seconds;
  renderCountdown();

  state.countdownTimer = setInterval(() => {
    state.countdownSecs--;
    renderCountdown();

    // Pre-emptive return at 3 seconds
    if (state.countdownSecs <= 3 && state.adActive) {
      const returning = document.getElementById('ytReturning');
      returning.style.display = 'block';
    }

    if (state.countdownSecs <= 0) {
      clearCountdown();
    }
  }, 1000);
}

function clearCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  state.countdownSecs = null;
  document.getElementById('ytCountdown').textContent = '';
}

function renderCountdown() {
  const s = state.countdownSecs;
  if (s === null || s <= 0) {
    document.getElementById('ytCountdown').textContent = '';
    return;
  }
  const m   = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  document.getElementById('ytCountdown').textContent = `${m}:${sec}`;
}

// ─── Keyboard shortcut ────────────────────────────────────────
// Press Enter on setup inputs to start
document.getElementById('twitchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('youtubeInput').focus();
});
document.getElementById('youtubeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startWatching();
});

// ─── Dev helper ───────────────────────────────────────────────
// Open console and run: simulateAd(true, 90) / simulateAd(false)
window.simulateAd = (isAd, duration) => handleAd(isAd, duration || null);
