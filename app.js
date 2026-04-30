// ─── Config ───────────────────────────────────────────────────
const WORKER_URL       = 'https://betterads-proxy.sotempyhehe.workers.dev';
const TWITCH_GQL       = 'https://gql.twitch.tv/gql';
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// ─── State ────────────────────────────────────────────────────
const state = {
  channel:        '',
  youtubeId:      '',
  isLiveStream:   false,
  adActive:       false,
  countdownSecs:  null,
  countdownTimer: null,
  _swapped:       false,
  ytDuration:     null,
  ytCurrent:      null,
  ytProgressTimer:null,
  smartAds:       true,  // default ON
  smartAdVideoId: null,
};

// ─── Favorites (localStorage) ─────────────────────────────────
let favorites = JSON.parse(localStorage.getItem('bc-favorites') || '[]');
const liveStatus = {};

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

// ─── Smart Ads playlist ───────────────────────────────────────
const playlist = {
  videos:       [],
  index:        0,
  pickedIndex:  null,
  refreshTimer: null,
  queryIndex:   0,  // cycles through query variants on each shuffle
};

// Query variants — each shuffle uses the next one, guaranteeing fresh results
const QUERY_VARIANTS = [
  (game) => `${game} highlights`,
  (game) => `${game} best moments`,
  (game) => `${game} funny clips`,
  (game) => `${game} gameplay`,
  (game) => `${game} montage`,
];

let lastGame = 'gaming';

async function buildPlaylist() {
  if (!state.smartAds) return;

  const carousel = document.getElementById('playlistCarousel');
  const loading  = document.getElementById('playlistLoading');
  if (carousel) carousel.style.display = 'flex';
  if (loading)  loading.style.display  = 'flex';

  const streamInfo = await fetchStreamGame(state.channel);
  if (streamInfo?.game) lastGame = streamInfo.game;

  const variantFn = QUERY_VARIANTS[playlist.queryIndex % QUERY_VARIANTS.length];
  const query     = variantFn(lastGame);
  console.log('[BetterAds] Playlist query:', query);

  const res = await searchYouTubeViaWorker(query, 5);
  if (loading) loading.style.display = 'none';

  if (!res || !res.length) return;

  playlist.videos      = res;
  playlist.index       = 0;
  playlist.pickedIndex = null;

  renderCarousel();
  renderHubYouTube();

  if (playlist.refreshTimer) clearInterval(playlist.refreshTimer);
  playlist.refreshTimer = setInterval(buildPlaylist, 10 * 60 * 1000);
}

async function shufflePlaylist() {
  const btn = document.querySelector('.playlist-shuffle-btn');
  if (btn) {
    btn.classList.add('spinning');
    setTimeout(() => btn.classList.remove('spinning'), 300);
  }
  // Advance to next query variant — guarantees fresh different results
  playlist.queryIndex = (playlist.queryIndex + 1) % QUERY_VARIANTS.length;
  playlist.pickedIndex = null;
  state.smartAdVideoId = null;
  await buildPlaylist();
}

function renderCarousel() {
  const videos = playlist.videos;
  if (!videos.length) return;

  const v        = videos[playlist.index];
  const thumb    = document.getElementById('playlistThumb');
  const title    = document.getElementById('playlistTitle');
  const counter  = document.getElementById('playlistCounter');
  const duration = document.getElementById('playlistDuration');
  const pickBtn  = document.querySelector('.playlist-pick-btn');
  const thumbWrap = document.getElementById('playlistThumbWrap');

  if (thumb)   { thumb.src = v.thumbnail; thumb.alt = v.title; }
  if (title)   title.textContent = v.title;
  if (counter) counter.textContent = `${playlist.index + 1} / ${videos.length}`;
  if (duration && v.duration) duration.textContent = parseIsoDuration(v.duration);
  else if (duration) duration.textContent = '';

  // Purple border when smart ads active
  if (thumbWrap) thumbWrap.classList.toggle('smart-active-border', state.smartAds);

  if (pickBtn) {
    const isPicked = playlist.pickedIndex === playlist.index;
    pickBtn.textContent = isPicked ? '✓ selected' : '✓ use this one';
    pickBtn.classList.toggle('picked', isPicked);
  }
}

function parseIsoDuration(iso) {
  // Converts PT4M13S → 4:13, PT1H2M3S → 1:02:03
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h = parseInt(m[1] || 0);
  const min = parseInt(m[2] || 0);
  const s = parseInt(m[3] || 0);
  if (h > 0) return `${h}:${String(min).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${min}:${String(s).padStart(2,'0')}`;
}

function carouselPrev() {
  if (!playlist.videos.length) return;
  playlist.index = (playlist.index - 1 + playlist.videos.length) % playlist.videos.length;
  renderCarousel();
}

function carouselNext() {
  if (!playlist.videos.length) return;
  playlist.index = (playlist.index + 1) % playlist.videos.length;
  renderCarousel();
}

function pickCarouselVideo() {
  playlist.pickedIndex = playlist.index;
  state.smartAdVideoId = null;
  renderCarousel();
  // If currently in an ad break, swap to picked video immediately
  if (state._swapped && state.smartAds) {
    loadSmartAd();
  }
}

function getPlaylistVideo() {
  // Return user-picked video, or random from playlist
  if (playlist.pickedIndex !== null && playlist.videos[playlist.pickedIndex]) {
    return playlist.videos[playlist.pickedIndex];
  }
  if (!playlist.videos.length) return null;
  return playlist.videos[Math.floor(Math.random() * playlist.videos.length)];
}

async function searchManualPlaylist() {
  const input = document.getElementById('hubKeywordInput');
  const query = input?.value.trim();
  if (!query) return;

  // Store keywords for use during ad breaks
  localStorage.setItem('ba-manual-keywords', query);

  const loading = document.getElementById('playlistLoading');
  const carousel = document.getElementById('playlistCarousel');
  if (carousel) carousel.style.display = 'flex';
  if (loading)  loading.style.display  = 'flex';

  const res = await searchYouTubeViaWorker(query, 5);
  if (loading) loading.style.display = 'none';

  if (!res?.length) {
    if (loading) loading.textContent = 'no results found';
    return;
  }

  playlist.videos      = res;
  playlist.index       = 0;
  playlist.pickedIndex = null;
  state.smartAdVideoId = null;

  renderCarousel();
  renderHubYouTube();
}

function toggleSmartAdsHub() {
  // Keep in sync with main toggle
  toggleSmartAds();
  syncHubSmartToggle();
  renderHubYouTube();
}

function syncHubSmartToggle() {
  const hubToggle = document.getElementById('hubSmartToggle');
  if (hubToggle) hubToggle.setAttribute('aria-pressed', state.smartAds);
}

function renderHubYouTube() {
  const smartSection  = document.getElementById('hubSmartSection');
  const manualSection = document.getElementById('hubManualSection');
  const carousel      = document.getElementById('playlistCarousel');
  const smartEmpty    = document.getElementById('hubSmartEmpty');
  const thumbWrap     = document.getElementById('playlistThumbWrap');

  if (state.smartAds) {
    if (smartSection)  smartSection.classList.remove('hub-section-grayed');
    if (manualSection) manualSection.classList.add('hub-section-grayed');
    if (thumbWrap)     thumbWrap.classList.add('smart-active-border');

    if (playlist.videos.length) {
      if (carousel)   carousel.style.display  = 'flex';
      if (smartEmpty) smartEmpty.style.display = 'none';
    } else {
      if (carousel)   carousel.style.display  = 'none';
      if (smartEmpty) smartEmpty.style.display = 'block';
    }
  } else {
    if (smartSection)  smartSection.classList.add('hub-section-grayed');
    if (manualSection) manualSection.classList.remove('hub-section-grayed');
    if (thumbWrap)     thumbWrap.classList.remove('smart-active-border');

    // Show carousel if manual playlist has been searched
    if (playlist.videos.length) {
      if (carousel)   carousel.style.display  = 'flex';
      if (smartEmpty) smartEmpty.style.display = 'none';
    } else {
      if (carousel)   carousel.style.display  = 'none';
    }
  }

  syncHubSmartToggle();
}

// ─── Smart Ads ────────────────────────────────────────────────
// On ad start: fetch current stream game via Twitch GQL,
// search YouTube via Cloudflare Worker proxy, load automatically.

function toggleSmartAds() {
  state.smartAds = !state.smartAds;
  const btn = document.getElementById('smartAdsToggle');
  btn.setAttribute('aria-pressed', state.smartAds);
  localStorage.setItem('ba-smart-ads', state.smartAds);

  // Dim/undim the YouTube input
  const input = document.getElementById('youtubeInput');
  if (state.smartAds && !input.value.trim()) {
    input.classList.add('smart-active');
    input.placeholder = 'smart ads on — keywords optional';
  } else {
    input.classList.remove('smart-active');
    input.placeholder = 'e.g. lofi music chill beats...';
  }
}

// Dim input if smart ads is on and no value typed
document.getElementById('youtubeInput').addEventListener('input', () => {
  const input = document.getElementById('youtubeInput');
  if (state.smartAds) {
    input.classList.toggle('smart-active', !input.value.trim());
  }
});

async function fetchStreamGame(channel) {
  try {
    const res = await fetch(TWITCH_GQL, {
      method:  'POST',
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        operationName: 'UsersInfo',
        variables:     { logins: [channel] },
        query: `query UsersInfo($logins: [String!]!) {
          users(logins: $logins) {
            login
            stream { title game { name } }
          }
        }`,
      }]),
    });
    if (!res.ok) return null;
    const data   = await res.json();
    const stream = data[0]?.data?.users?.[0]?.stream;
    return stream ? { game: stream.game?.name || '', title: stream.title || '' } : null;
  } catch (_) { return null; }
}

async function searchYouTubeViaWorker(query, maxResults = 5) {
  try {
    const res  = await fetch(`${WORKER_URL}?q=${encodeURIComponent(query)}&max=${maxResults}`);
    if (!res.ok) return null;
    const data  = await res.json();
    const items = data.items?.filter(i => i.id?.videoId);
    if (!items?.length) return null;
    return items
      .map(i => ({
        id:        i.id.videoId,
        title:     i.snippet?.title || '',
        thumbnail: i.snippet?.thumbnails?.medium?.url || `https://img.youtube.com/vi/${i.id.videoId}/mqdefault.jpg`,
        duration:  i.contentDetails?.duration || null,
        durationSecs: parseDurationSecs(i.contentDetails?.duration),
      }))
      .filter(v => v.durationSecs === null || v.durationSecs >= 180); // min 3 minutes
  } catch (_) { return null; }
}

function parseDurationSecs(iso) {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
}

async function loadSmartAd() {
  // If a video is already loaded from a previous ad break, just resume it
  if (state.smartAdVideoId) {
    console.log('[BetterAds] Smart Ads resuming:', state.smartAdVideoId);
    ytCommand('playVideo');
    startYtProgress();
    const label = document.getElementById('ytAdLabel');
    if (label) {
      const current = playlist.videos.find(v => v.id === state.smartAdVideoId);
      if (current) label.textContent = `▶ ${current.title.slice(0, 45)}${current.title.length > 45 ? '…' : ''}`;
    }
    return;
  }

  // No video loaded yet — pick from playlist or search on the fly
  let video = getPlaylistVideo();

  if (!video) {
    const countdownEl = document.getElementById('ytCountdown');
    if (countdownEl) countdownEl.textContent = 'finding...';
    const streamInfo = await fetchStreamGame(state.channel);
    const query = streamInfo?.game ? `${streamInfo.game} highlights` : 'gaming highlights';
    const results = await searchYouTubeViaWorker(query, 5);
    if (countdownEl) countdownEl.textContent = '';
    if (results?.length) {
      playlist.videos = results;
      video = results[0];
    }
  }

  if (!video) {
    // Final fallback — use manual keywords if available
    const savedKeywords = localStorage.getItem('ba-manual-keywords');
    if (savedKeywords) {
      const results = await searchYouTubeViaWorker(savedKeywords, 5);
      if (results?.length) video = results[0];
    }
    if (!video) return;
  }

  console.log('[BetterAds] Smart Ads loading:', video.title);
  state.smartAdVideoId = video.id;
  // Load with autoplay for smart ads
  document.getElementById('youtubeFrame').src =
    `https://www.youtube.com/embed/${video.id}?enablejsapi=1&autoplay=1`;
  startYtProgress();

  const label = document.getElementById('ytAdLabel');
  if (label) label.textContent = `▶ ${video.title.slice(0, 45)}${video.title.length > 45 ? '…' : ''}`;
}

function clearSmartAd() {
  // Restore label
  const label = document.getElementById('ytAdLabel');
  if (label) label.textContent = 'ad break';
  state.smartAdVideoId = null;
  // Blank the frame so it stops playing
  document.getElementById('youtubeFrame').src = 'about:blank';
}

// ─── Setup ────────────────────────────────────────────────────
function startWatching(channel) {
  const channelVal = (channel || document.getElementById('twitchInput').value.trim()).toLowerCase();
  if (!channelVal) { shake('twitchInput'); return; }

  // Save manual keywords if entered
  const keywordVal = document.getElementById('youtubeInput')?.value.trim() || '';
  if (keywordVal && !state.smartAds) {
    localStorage.setItem('ba-manual-keywords', keywordVal);
  }

  state.channel   = channelVal;
  state.youtubeId = '';

  loadTwitch(channelVal);

  document.getElementById('watchChannel').textContent = channelVal;
  document.getElementById('setupScreen').style.display = 'none';
  document.getElementById('watchScreen').style.display = 'block';

  window.addEventListener('message', onMessage);
  startExtensionCheck();

  renderHubYouTube();
  renderFavorites();
  startLivePolling();

  if (state.smartAds) {
    buildPlaylist();
  } else {
    // Auto-search manual keywords if saved
    const savedKeywords = localStorage.getItem('ba-manual-keywords');
    if (savedKeywords) searchWithKeywords(savedKeywords);
  }
}

async function searchWithKeywords(query) {
  const loading = document.getElementById('playlistLoading');
  const carousel = document.getElementById('playlistCarousel');
  if (carousel) carousel.style.display = 'flex';
  if (loading)  loading.style.display  = 'flex';
  const res = await searchYouTubeViaWorker(query, 5);
  if (loading) loading.style.display = 'none';
  if (!res?.length) return;
  playlist.videos      = res;
  playlist.index       = 0;
  playlist.pickedIndex = null;
  renderCarousel();
  renderHubYouTube();
}

function loadTwitch(channel) {
  document.getElementById('twitchFrame').src =
    `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${location.hostname}&autoplay=true`;
}

function isLiveStreamUrl(url) {
  return /youtube\.com\/live\//i.test(url) ||
         /youtube\.com\/@[^/]+\/live/i.test(url);
}

function loadYouTube(id, originalUrl) {
  state.youtubeId    = id;
  state.isLiveStream = originalUrl ? isLiveStreamUrl(originalUrl) : false;
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
  state.adActive       = false;
  state._swapped       = false;
  state.channel        = '';
  state.youtubeId      = '';
  state.smartAdVideoId = null;
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
  syncHubSmartToggle();
  renderHubYouTube();
  renderFavorites();
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

// ─── Hub: YouTube section render ──────────────────────────────
function renderHubYouTube() {
  const smartSection  = document.getElementById('hubSmartSection');
  const manualSection = document.getElementById('hubManualSection');
  const carousel      = document.getElementById('playlistCarousel');
  const smartEmpty    = document.getElementById('hubSmartEmpty');
  const thumbWrap     = document.getElementById('playlistThumbWrap');

  if (state.smartAds) {
    if (smartSection)  smartSection.classList.remove('hub-section-grayed');
    if (manualSection) manualSection.classList.add('hub-section-grayed');
    if (thumbWrap)     thumbWrap.classList.add('smart-active-border');
    if (playlist.videos.length) {
      if (carousel)   carousel.style.display  = 'flex';
      if (smartEmpty) smartEmpty.style.display = 'none';
    } else {
      if (carousel)   carousel.style.display  = 'none';
      if (smartEmpty) smartEmpty.style.display = 'block';
    }
  } else {
    if (smartSection)  smartSection.classList.add('hub-section-grayed');
    if (manualSection) manualSection.classList.remove('hub-section-grayed');
    if (thumbWrap)     thumbWrap.classList.remove('smart-active-border');
    if (playlist.videos.length) {
      if (carousel)   carousel.style.display  = 'flex';
      if (smartEmpty) smartEmpty.style.display = 'none';
    } else {
      if (carousel)   carousel.style.display  = 'none';
    }
  }

  syncHubSmartToggle();
}

// Safe event delegation for hub inputs
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const id = e.target?.id;
  if (id === 'favInput')        addFavorite();
  if (id === 'hubKeywordInput') searchManualPlaylist();
});

// ─── YouTube progress tracking ────────────────────────────────
window.addEventListener('message', e => {
  if (!e.data) return;
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (data.event === 'infoDelivery' && data.info) {
      if (data.info.duration)                  state.ytDuration   = data.info.duration;
      if (data.info.currentTime !== undefined) state.ytCurrent    = data.info.currentTime;
      if (data.info.isLive !== undefined)      state.isLiveStream = !!data.info.isLive;
      updateYtProgressDisplay();

      // playerState 0 = video ended — auto advance playlist
      if (data.info.playerState === 0 && state.smartAds && state._swapped) {
        console.log('[BetterAds] Video ended — advancing to next');
        state.smartAdVideoId = null;
        playlist.pickedIndex = null;
        playlist.index = (playlist.index + 1) % (playlist.videos.length || 1);
        loadSmartAd();
      }
    }
  } catch (_) {}
});

function startYtProgress() {
  stopYtProgress();
  state.ytProgressTimer = setInterval(() => {
    ytCommand('getVideoData');
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
  // Progress display is now only in the carousel overlay — handled by renderCarousel
  // Nothing to update here for the hub since old progress elements were removed
}

function formatTime(secs) {
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Favorites ────────────────────────────────────────────────
function sortedFavorites() {
  return [...favorites].sort((a, b) => {
    const aLive = liveStatus[a] ? 1 : 0;
    const bLive = liveStatus[b] ? 1 : 0;
    return bLive - aLive;
  });
}

function renderFavorites() {
  const container = document.getElementById('hubFavorites');
  container.innerHTML = '';

  if (favorites.length === 0) {
    container.innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:var(--muted);padding:4px 0;">no favorites yet</div>`;
    return;
  }

  sortedFavorites().forEach(ch => {
    const i    = favorites.indexOf(ch);
    const item = document.createElement('div');
    item.className = 'fav-item';
    item.id        = `fav-${ch}`;
    item.innerHTML = `
      <span class="fav-live-dot${liveStatus[ch] ? ' live' : ''}" id="fav-dot-${ch}"></span>
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
  renderSetupDock();
  checkAllLive();
}

function removeFavorite(index) {
  favorites.splice(index, 1);
  saveFavorites();
  renderFavorites();
  renderSetupDock();
}

function switchToChannel(channel) {
  state.channel = channel;
  loadTwitch(channel);
  document.getElementById('watchChannel').textContent = channel;
  closeHub();
}

// ─── Live status checking ─────────────────────────────────────
let liveTimer = null;

function startLivePolling() {
  stopLivePolling();
  console.log('[BC] Live polling started for:', favorites);
  checkAllLive();
  liveTimer = setInterval(checkAllLive, 60000);
}

function stopLivePolling() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

async function checkAllLive() {
  if (favorites.length === 0) return;
  const queries = favorites.map(ch => ({
    operationName: 'UsersInfo',
    variables:     { logins: [ch] },
    query: `query UsersInfo($logins: [String!]!) { users(logins: $logins) { login stream { id } } }`,
  }));
  try {
    const res = await fetch(TWITCH_GQL, {
      method:  'POST',
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify(queries),
    });
    if (!res.ok) { console.warn('[BC] GQL live check failed:', res.status); return; }
    const data    = await res.json();
    const results = Array.isArray(data) ? data : [data];
    results.forEach((item, i) => {
      const ch     = favorites[i];
      const isLive = !!(item?.data?.users?.[0]?.stream);
      setLiveDot(ch, isLive);
    });
  } catch (err) { console.warn('[BC] GQL live check error:', err); }
}

function setLiveDot(channel, isLive) {
  const changed = liveStatus[channel] !== isLive;
  liveStatus[channel] = isLive;

  const dot      = document.getElementById(`fav-dot-${channel}`);
  const setupDot = document.getElementById(`setup-dot-${channel}`);
  if (dot)      dot.classList.toggle('live', isLive);
  if (setupDot) setupDot.classList.toggle('live', isLive);

  if (changed) { renderFavorites(); renderSetupDock(); }
  if (dot) dot.title = isLive ? `${channel} is live` : `${channel} is offline`;
}

// ─── Extension handshake ──────────────────────────────────────
let extDetected   = false;
let extCheckTimer = null;

function startExtensionCheck() {
  extDetected = false;
  clearTimeout(extCheckTimer);
  extCheckTimer = setTimeout(() => {
    if (!extDetected) showExtWarning();
  }, 8000);
}

function showExtWarning() {
  document.getElementById('extWarning').style.display = 'flex';
}

function dismissExtWarning() {
  document.getElementById('extWarning').style.display = 'none';
  clearTimeout(extCheckTimer);
}

function copyDebuggingUrl(btn) {
  navigator.clipboard.writeText('about:debugging#/runtime/this-firefox').then(() => {
    window.open('about:blank', '_blank');
    btn.textContent = '✓ copied — paste in new tab';
    setTimeout(() => { btn.textContent = 'about:debugging ↗'; }, 2500);
  });
}

// ─── Message handler ──────────────────────────────────────────
function onMessage(e) {
  if (!e.data || typeof e.data !== 'object') return;

  if (e.data.source === 'betterads-extension' && e.data.type === 'ba-ready') {
    extDetected = true;
    clearTimeout(extCheckTimer);
    document.getElementById('extWarning').style.display = 'none';
    return;
  }

  if (e.data.source !== 'betterads-extension' &&
      e.data.source !== 'gridview-extension') return;
  if (e.data.type !== 'vg-ad') return;
  const ch = (e.data.channel || '').toLowerCase().trim();
  if (ch && ch !== state.channel) return;
  handleAd(!!e.data.active, e.data.duration || null);
}

// ─── Ad handling ──────────────────────────────────────────────
function handleAd(isAd, duration) {
  if (state.adActive === isAd) {
    if (isAd && duration) startCountdown(duration);
    return;
  }
  state.adActive = isAd;
  if (isAd) {
    showYouTube(duration);
  } else {
    returnToTwitch();
  }
}

async function showYouTube(duration) {
  state._swapped = true;
  document.getElementById('ytOverlay').classList.add('visible');
  document.getElementById('ytReturning').style.display = 'none';
  if (duration) startCountdown(duration);

  if (state.smartAds) {
    // Smart Ads: search for a contextual video
    await loadSmartAd();
  } else {
    if (!state.youtubeId) return;
    ytCommand('playVideo');
    if (state.isLiveStream) {
      setTimeout(() => ytCommandWithArgs('seekTo', [999999, true]), 800);
    }
    startYtProgress();
  }
}

function returnToTwitch() {
  if (!state._swapped) return;
  document.getElementById('ytReturning').style.display = 'block';
  setTimeout(() => {
    if (state.smartAds) {
      clearSmartAd();
    } else {
      ytCommand('pauseVideo');
    }
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

function ytCommandWithArgs(func, args) {
  try {
    document.getElementById('youtubeFrame').contentWindow.postMessage(
      JSON.stringify({ event: 'command', func, args }), '*'
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
    if (state.countdownSecs <= 3 && state.adActive)
      document.getElementById('ytReturning').style.display = 'block';
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

// ─── Setup dock ───────────────────────────────────────────────
function renderSetupDock() {
  const dock     = document.getElementById('setupDock');
  const channels = document.getElementById('setupDockChannels');
  if (!dock || !channels) return; // not on setup screen

  if (favorites.length === 0) { dock.style.display = 'none'; return; }

  dock.style.display = 'flex';
  channels.innerHTML = '';

  sortedFavorites().forEach(ch => {
    const chip = document.createElement('div');
    chip.className = 'setup-dock-chip';
    chip.id        = `setup-chip-${ch}`;
    chip.innerHTML = `
      <span class="setup-dock-chip-dot" id="setup-dot-${ch}"></span>
      ${ch}
    `;
    chip.onclick = () => quickStart(ch);
    channels.appendChild(chip);
  });

  checkAllLive();
}

let toastTimer = null;
function showToast() {
  const toast = document.getElementById('setupToast');
  toast.style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function quickStart(channel) {
  document.getElementById('twitchInput').value = channel;
  startWatching();
}

// ─── Key handlers ─────────────────────────────────────────────
document.getElementById('twitchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('youtubeInput').focus();
});
document.getElementById('youtubeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startWatching();
});

// ─── Dev helpers ──────────────────────────────────────────────
window.simulateAd = (isAd, duration) => handleAd(isAd, duration || null);

// ─── Init ─────────────────────────────────────────────────────
// Restore smart ads preference — default ON if never set
const savedSmartAds = localStorage.getItem('ba-smart-ads');
state.smartAds = savedSmartAds === null ? true : savedSmartAds === 'true';
localStorage.setItem('ba-smart-ads', state.smartAds);

// Apply smart ads toggle state to UI
const toggleBtn = document.getElementById('smartAdsToggle');
toggleBtn.setAttribute('aria-pressed', state.smartAds);

// YouTube field: never pre-fill, only show smart-active dim when smart ads on
const ytInput = document.getElementById('youtubeInput');
ytInput.value = '';
if (state.smartAds) {
  ytInput.classList.add('smart-active');
  ytInput.placeholder = 'smart ads on — keywords optional';
} else {
  ytInput.placeholder = 'e.g. lofi music chill beats...';
}

// Render favorites dock
renderSetupDock();
