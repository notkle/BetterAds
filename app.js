// ─── State ────────────────────────────────────────────────────
const state = {
  channel:        '',
  youtubeId:      '',
  adActive:       false,
  countdownSecs:  null,
  countdownTimer: null,
  _swapped:       false,
  ytDuration:     null,  // total seconds of YT video
  ytCurrent:      null,  // current playback position
  ytProgressTimer:null,
};

// ─── Favorites (localStorage) ─────────────────────────────────
let favorites = JSON.parse(localStorage.getItem('bc-favorites') || '[]');

function saveFavorites() {
  localStorage.setItem('bc-favorites', JSON.stringify(favorites));
}

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
function startWatching(channel) {
  const channelVal = (channel || document.getElementById('twitchInput').value.trim()).toLowerCase();
  const ytVal      = document.getElementById('youtubeInput')?.value.trim() || state.youtubeId;

  if (!channelVal) { shake('twitchInput'); return; }

  let ytId = null;
  if (ytVal) {
    ytId = extractYouTubeId(ytVal);
    if (!ytId && ytVal) { shake('youtubeInput'); return; }
  }

  state.channel   = channelVal;
  state.youtubeId = ytId || '';

  loadTwitch(channelVal);
  if (ytId) loadYouTube(ytId);

  document.getElementById('watchChannel').textContent = channelVal;
  document.getElementById('setupScreen').style.display = 'none';
  document.getElementById('watchScreen').style.display = 'block';

  window.addEventListener('message', onMessage);

  // Pre-fill hub YouTube input with current value
  document.getElementById('hubYtInput').value = ytVal || '';

  renderHubYouTube();
  renderFavorites();
  startLivePolling();
}

function loadTwitch(channel) {
  document.getElementById('twitchFrame').src =
    `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${location.hostname}&autoplay=true`;
}

function loadYouTube(id) {
  state.youtubeId = id;
  document.getElementById('youtubeFrame').src =
    `https://www.youtube.com/embed/${id}?enablejsapi=1&autoplay=0`;
  renderHubYouTube();
}

function shake(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.classList.add('error');
  el.animate([
    { transform: 'translateX(0)' },
    { transform: 'translateX(-6px)' },
    { transform: 'translateX(6px)' },
    { transform: 'translateX(-4px)' },
    { transform: 'translateX(0)' },
  ], { duration: 300, easing: 'ease-out' });
  setTimeout(() => el.classList.remove('error'), 2000);
}

function goBack() {
  clearCountdown();
  stopLivePolling();
  stopYtProgress();
  document.getElementById('twitchFrame').src = 'about:blank';
  document.getElementById('youtubeFrame').src = 'about:blank';
  hideYouTube(false);
  window.removeEventListener('message', onMessage);
  state.adActive  = false;
  state._swapped  = false;
  state.channel   = '';
  state.youtubeId = '';
  closeHub();
  document.getElementById('setupScreen').style.display = 'flex';
  document.getElementById('watchScreen').style.display = 'none';
}

// ─── Hub ──────────────────────────────────────────────────────
let hubOpen = false;
let hubHideTimer = null;

const hubTrigger = document.getElementById('hubTrigger');
const hub        = document.getElementById('hub');

hubTrigger.addEventListener('mouseenter', openHub);
hub.addEventListener('mouseleave', scheduleHubClose);
hub.addEventListener('mouseenter', cancelHubClose);
hubTrigger.addEventListener('mouseleave', scheduleHubClose);

function openHub() {
  cancelHubClose();
  hub.classList.add('open');
  hubOpen = true;
}

function closeHub() {
  hub.classList.remove('open');
  hubOpen = false;
}

function scheduleHubClose() {
  cancelHubClose();
  hubHideTimer = setTimeout(closeHub, 400);
}

function cancelHubClose() {
  if (hubHideTimer) { clearTimeout(hubHideTimer); hubHideTimer = null; }
}

// ─── Hub: YouTube editing ─────────────────────────────────────
function saveYouTubeUrl() {
  const val = document.getElementById('hubYtInput').value.trim();
  if (!val) {
    // Clear YouTube
    state.youtubeId = '';
    document.getElementById('youtubeFrame').src = 'about:blank';
    renderHubYouTube();
    return;
  }
  const id = extractYouTubeId(val);
  if (!id) { shake('hubYtInput'); return; }
  loadYouTube(id);
  // Visual feedback
  const btn = document.querySelector('.hub-save-btn');
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = 'save'; }, 1500);
}

document.getElementById('hubYtInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveYouTubeUrl();
});

function renderHubYouTube() {
  const thumb   = document.getElementById('ytThumb');
  const noVideo = document.getElementById('ytNoVideo');
  const overlay = document.getElementById('ytThumbOverlay');

  if (!state.youtubeId) {
    thumb.style.display   = 'none';
    overlay.style.display = 'none';
    noVideo.style.display = 'flex';
    return;
  }

  noVideo.style.display = 'none';
  thumb.src = `https://img.youtube.com/vi/${state.youtubeId}/mqdefault.jpg`;
  thumb.style.display   = 'block';
  overlay.style.display = 'block';
}

// ─── YouTube progress tracking ────────────────────────────────
// YouTube's postMessage API returns state via 'message' events
// We poll by sending getVideoData / getCurrentTime requests

window.addEventListener('message', e => {
  if (!e.data) return;
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (data.event === 'infoDelivery' && data.info) {
      if (data.info.duration)     state.ytDuration = data.info.duration;
      if (data.info.currentTime !== undefined) state.ytCurrent = data.info.currentTime;
      updateYtProgressDisplay();
    }
  } catch (_) {}
});

function startYtProgress() {
  stopYtProgress();
  // Request info every 2 seconds
  state.ytProgressTimer = setInterval(() => {
    ytCommand('getVideoData');
    // getCurrentTime via listening event — we poke the iframe
    try {
      document.getElementById('youtubeFrame').contentWindow.postMessage(
        JSON.stringify({ event: 'listening' }), '*'
      );
    } catch (_) {}
  }, 2000);
}

function stopYtProgress() {
  if (state.ytProgressTimer) {
    clearInterval(state.ytProgressTimer);
    state.ytProgressTimer = null;
  }
}

function updateYtProgressDisplay() {
  const cur   = state.ytCurrent;
  const total = state.ytDuration;
  if (cur === null || total === null || total === 0) return;

  const pct = Math.min(100, (cur / total) * 100);
  document.getElementById('ytProgressFill').style.width = pct + '%';
  document.getElementById('ytTimeCurrent').textContent  = formatTime(cur);
  document.getElementById('ytTimeTotal').textContent    = formatTime(total);
}

function formatTime(secs) {
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, '0');
  return `${m}:${r}`;
}

// ─── Favorites ────────────────────────────────────────────────
function renderFavorites() {
  const container = document.getElementById('hubFavorites');
  container.innerHTML = '';

  if (favorites.length === 0) {
    container.innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:var(--muted);padding:4px 0;">no favorites yet</div>`;
    return;
  }

  favorites.forEach((ch, i) => {
    const item = document.createElement('div');
    item.className   = 'fav-item';
    item.id          = `fav-${ch}`;
    item.innerHTML = `
      <span class="fav-live-dot" id="fav-dot-${ch}"></span>
      <span class="fav-name">${ch}</span>
      <button class="fav-watch-btn" onclick="switchToChannel('${ch}')">watch</button>
      <button class="fav-remove-btn" onclick="removeFavorite(${i})" title="Remove">✕</button>
    `;
    container.appendChild(item);
  });
}

function addFavorite() {
  const val = document.getElementById('favInput').value.trim().toLowerCase();
  if (!val) return;
  if (favorites.includes(val)) {
    document.getElementById('favInput').value = '';
    return;
  }
  favorites.push(val);
  saveFavorites();
  document.getElementById('favInput').value = '';
  renderFavorites();
  checkLive(val);
}

function removeFavorite(index) {
  favorites.splice(index, 1);
  saveFavorites();
  renderFavorites();
}

function switchToChannel(channel) {
  state.channel = channel;
  loadTwitch(channel);
  document.getElementById('watchChannel').textContent = channel;
  closeHub();
}

document.getElementById('favInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addFavorite();
});

// ─── Live status checking ─────────────────────────────────────
// Uses Twitch's stream thumbnail — only exists when channel is live.
// No API key required. Checks every 60 seconds.
let liveTimer = null;

function startLivePolling() {
  stopLivePolling();
  checkAllLive();
  liveTimer = setInterval(checkAllLive, 60000);
}

function stopLivePolling() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

function checkAllLive() {
  favorites.forEach(ch => checkLive(ch));
}

function checkLive(channel) {
  const img = new Image();
  const ts  = Date.now(); // cache bust
  img.src   = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel}-320x180.jpg?ts=${ts}`;

  img.onload = () => {
    // Twitch returns a small placeholder (usually < 3KB) when offline
    // A real live thumbnail is much larger
    // We check naturalWidth — offline placeholder is exactly 320x180 solid color
    // Live thumbnails have real content. Not 100% reliable but good enough.
    setLiveDot(channel, img.naturalWidth >= 100 && img.naturalHeight >= 50);
  };
  img.onerror = () => setLiveDot(channel, false);
}

function setLiveDot(channel, isLive) {
  const dot = document.getElementById(`fav-dot-${channel}`);
  if (!dot) return;
  if (isLive) {
    dot.classList.add('live');
    dot.title = `${channel} is live!`;
  } else {
    dot.classList.remove('live');
    dot.title = '';
  }
}

// ─── Ad handling ──────────────────────────────────────────────
function onMessage(e) {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.source !== 'bettercommercials-extension' &&
      e.data.source !== 'gridview-extension') return;
  if (e.data.type !== 'vg-ad') return;
  const ch = (e.data.channel || '').toLowerCase().trim();
  if (ch && ch !== state.channel) return;
  handleAd(!!e.data.active, e.data.duration || null);
}

function handleAd(isAd, duration) {
  if (state.adActive === isAd) {
    if (isAd && duration) startCountdown(duration);
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

function showYouTube() {
  if (!state.youtubeId) return;
  state._swapped = true;
  document.getElementById('ytOverlay').classList.add('visible');
  document.getElementById('ytReturning').style.display = 'none';
  ytCommand('playVideo');
  startYtProgress();
}

function returnToTwitch() {
  if (!state._swapped) return;
  document.getElementById('ytReturning').style.display = 'block';
  setTimeout(() => {
    ytCommand('pauseVideo');
    stopYtProgress();
    const overlay = document.getElementById('ytOverlay');
    overlay.style.transition = 'opacity 0.6s ease';
    overlay.classList.remove('visible');
    document.getElementById('ytReturning').style.display = 'none';
    state._swapped = false;
    clearCountdown();
  }, 1000);
}

function hideYouTube(animate) {
  const overlay = document.getElementById('ytOverlay');
  if (animate) overlay.style.transition = 'opacity 0.6s ease';
  overlay.classList.remove('visible');
  document.getElementById('ytReturning').style.display = 'none';
  document.getElementById('ytCountdown').textContent = '';
}

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
    if (state.countdownSecs <= 3 && state.adActive) {
      document.getElementById('ytReturning').style.display = 'block';
    }
    if (state.countdownSecs <= 0) clearCountdown();
  }, 1000);
}

function clearCountdown() {
  if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
  state.countdownSecs = null;
  document.getElementById('ytCountdown').textContent = '';
}

function renderCountdown() {
  const s = state.countdownSecs;
  if (!s || s <= 0) { document.getElementById('ytCountdown').textContent = ''; return; }
  const m = Math.floor(s / 60);
  document.getElementById('ytCountdown').textContent = `${m}:${String(s % 60).padStart(2,'0')}`;
}

// ─── Setup key handlers ───────────────────────────────────────
document.getElementById('twitchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('youtubeInput').focus();
});
document.getElementById('youtubeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startWatching();
});

// ─── Dev helpers ──────────────────────────────────────────────
window.simulateAd = (isAd, duration) => handleAd(isAd, duration || null);
