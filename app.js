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

  // Save to history
  saveToHistory(query);
  document.getElementById('hubSearchHistory').style.display = 'none';
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

// ─── Search history ───────────────────────────────────────────
const MAX_HISTORY = 10;
let searchHistory = JSON.parse(localStorage.getItem('ba-search-history') || '[]');

function saveToHistory(query) {
  searchHistory = searchHistory.filter(h => h !== query); // remove dupe
  searchHistory.unshift(query); // add to front
  if (searchHistory.length > MAX_HISTORY) searchHistory.pop();
  localStorage.setItem('ba-search-history', JSON.stringify(searchHistory));
}

function deleteFromHistory(query, e) {
  e.stopPropagation();
  searchHistory = searchHistory.filter(h => h !== query);
  localStorage.setItem('ba-search-history', JSON.stringify(searchHistory));
  const input = document.getElementById('hubKeywordInput');
  renderHistoryDropdown(input?.value || '');
}

function renderHistoryDropdown(filter) {
  const el = document.getElementById('hubSearchHistory');
  if (!el) return;

  const matches = searchHistory.filter(h =>
    filter.trim() === '' ? false : h.toLowerCase().includes(filter.toLowerCase())
  );

  if (!matches.length) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  el.innerHTML = matches.map(h => `
    <div class="hub-history-item" onclick="selectHistory('${h.replace(/'/g, "\\'")}')">
      <span class="hub-history-text">${h}</span>
      <button class="hub-history-del" onclick="deleteFromHistory('${h.replace(/'/g, "\\'")}', event)">✕</button>
    </div>
  `).join('');
}

function selectHistory(query) {
  const input = document.getElementById('hubKeywordInput');
  if (input) input.value = query;
  document.getElementById('hubSearchHistory').style.display = 'none';
  searchManualPlaylist();
}

// ─── Skip to next video ───────────────────────────────────────
function skipToNext() {
  if (!state._swapped || !playlist.videos.length) return;
  state.smartAdVideoId = null;
  playlist.pickedIndex = null;
  playlist.index = (playlist.index + 1) % playlist.videos.length;
  loadSmartAd();
}

function updateSkipBtn() {
  const btn = document.getElementById('ytSkipBtn');
  if (!btn) return;
  // Show skip button only when swapped and playlist has more than 1 video
  btn.style.display = (state._swapped && playlist.videos.length > 1) ? 'flex' : 'none';
}

// ─── Smart Ads ────────────────────────────────────────────────
// On ad start: fetch current stream game via Twitch GQL,
// search YouTube via Cloudflare Worker proxy, load automatically.

function toggleSmartAds() {
  state.smartAds = !state.smartAds;
  const btn = document.getElementById('smartAdsToggle');
  if (btn) btn.setAttribute('aria-pressed', state.smartAds);
  localStorage.setItem('ba-smart-ads', state.smartAds);

  // If turned ON during a watch session, rebuild playlist for current stream
  if (state.smartAds && state.channel) {
    state.smartAdVideoId = null;
    playlist.videos      = [];
    playlist.index       = 0;
    playlist.pickedIndex = null;
    buildPlaylist();
  }

  // Dim/undim the YouTube input on setup screen
  const input = document.getElementById('youtubeInput');
  if (input) {
    if (state.smartAds && !input.value.trim()) {
      input.classList.add('smart-active');
      input.placeholder = 'smart ads on — keywords optional';
    } else {
      input.classList.remove('smart-active');
      input.placeholder = 'e.g. lofi music chill beats...';
    }
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
    // Fetch more results than needed, then randomly sample for variety
    const fetchCount = maxResults <= 5 ? 20 : maxResults;
    const res  = await fetch(`${WORKER_URL}?q=${encodeURIComponent(query)}&max=${fetchCount}`);
    if (!res.ok) return null;
    const data  = await res.json();
    const items = data.items?.filter(i => i.id?.videoId);
    if (!items?.length) return null;

    const mapped = items
      .map(i => ({
        id:           i.id.videoId,
        title:        i.snippet?.title || '',
        thumbnail:    i.snippet?.thumbnails?.medium?.url || `https://img.youtube.com/vi/${i.id.videoId}/mqdefault.jpg`,
        duration:     i.contentDetails?.duration || null,
        durationSecs: parseDurationSecs(i.contentDetails?.duration),
      }))
      .filter(v => v.durationSecs === null || v.durationSecs >= 120);

    // Randomly shuffle and take requested count
    const shuffled = mapped.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, maxResults);
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

// ─── Twitch SDK player ────────────────────────────────────────
let twitchPlayer = null;

function loadTwitch(channel) {
  const savedVol = parseFloat(localStorage.getItem('ba-twitch-volume') || '1.0');

  // Wait for SDK to load if not ready yet
  if (typeof Twitch === 'undefined') {
    console.warn('[BetterAds] Waiting for Twitch SDK...');
    setTimeout(() => loadTwitch(channel), 300);
    return;
  }

  // Destroy existing player if any
  if (twitchPlayer) {
    try { twitchPlayer.destroy(); } catch (_) {}
    twitchPlayer = null;
    document.getElementById('twitchPlayer').innerHTML = '';
  }

  twitchPlayer = new Twitch.Player('twitchPlayer', {
    channel:    channel,
    parent:     [location.hostname],
    autoplay:   true,
    muted:      false,
    volume:     savedVol,
    width:      '100%',
    height:     '100%',
  });

  // Set max quality once player is ready
  twitchPlayer.addEventListener(Twitch.Player.READY, () => {
    setMaxQuality();
  });

  // Save volume changes
  twitchPlayer.addEventListener(Twitch.Player.PLAYBACK_STATS, () => {
    try {
      const vol = twitchPlayer.getVolume();
      localStorage.setItem('ba-twitch-volume', vol);
    } catch (_) {}
  });
}

function setMaxQuality(btn) {
  if (!twitchPlayer) return;
  try {
    const qualities = twitchPlayer.getQualities();
    if (qualities && qualities.length > 0) {
      // Qualities are ordered best-first — pick index 0
      twitchPlayer.setQuality(qualities[0].group);
      if (btn) {
        btn.classList.add('quality-set');
        btn.title = `quality: ${qualities[0].name}`;
        setTimeout(() => btn.classList.remove('quality-set'), 2000);
      }
      console.log('[BetterAds] Quality set to:', qualities[0].name);
    }
  } catch (_) {}
}

function muteTwitch() {
  if (twitchPlayer) twitchPlayer.setMuted(true);
}

function unmuteTwitch() {
  if (twitchPlayer) twitchPlayer.setMuted(false);
}

// Fade YouTube volume to 0 over duration ms then call done()
function fadeOutYouTube(duration, done) {
  const steps    = 20;
  const interval = duration / steps;
  let   step     = 0;
  const timer = setInterval(() => {
    step++;
    const vol = Math.max(0, 1 - step / steps);
    try {
      ytCommandWithArgs('setVolume', [Math.round(vol * 100)]);
    } catch (_) {}
    if (step >= steps) {
      clearInterval(timer);
      if (done) done();
    }
  }, interval);
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
  if (twitchPlayer) {
    try { twitchPlayer.destroy(); } catch (_) {}
    twitchPlayer = null;
    document.getElementById('twitchPlayer').innerHTML = '';
  }
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
  updateFinishToggleUI();
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
  const smartSection   = document.getElementById('hubSmartSection');
  const manualSection  = document.getElementById('hubManualSection');
  const carousel       = document.getElementById('playlistCarousel');
  const smartEmpty     = document.getElementById('hubSmartEmpty');
  const thumbWrap      = document.getElementById('playlistThumbWrap');
  const keywordRow     = document.querySelector('.hub-keyword-row');
  const keywordHint    = document.querySelector('.hub-keyword-hint');

  // Never gray the carousel — both modes use it
  if (smartSection)  smartSection.classList.remove('hub-section-grayed');
  if (manualSection) manualSection.classList.remove('hub-section-grayed');

  // Only gray the keyword input row when smart ads is ON
  if (keywordRow)  keywordRow.classList.toggle('hub-section-grayed', state.smartAds);
  if (keywordHint) keywordHint.classList.toggle('hub-section-grayed', state.smartAds);

  // Purple border only when smart ads is active
  if (thumbWrap) thumbWrap.classList.toggle('smart-active-border', state.smartAds);

  // Show carousel if either mode has videos
  if (playlist.videos.length) {
    if (carousel)   carousel.style.display  = 'flex';
    if (smartEmpty) smartEmpty.style.display = 'none';
  } else {
    if (carousel)   carousel.style.display  = 'none';
    if (smartEmpty) smartEmpty.style.display = state.smartAds ? 'block' : 'none';
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

// Search history dropdown on input
document.addEventListener('input', e => {
  if (e.target?.id === 'hubKeywordInput') {
    renderHistoryDropdown(e.target.value);
  }
});

// Hide dropdown on click outside
document.addEventListener('click', e => {
  if (!e.target?.closest('.hub-keyword-wrap')) {
    const el = document.getElementById('hubSearchHistory');
    if (el) el.style.display = 'none';
  }
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

      // playerState 0 = video ended
      if (data.info.playerState === 0 && state._swapped) {
        if (finishState.onceActive && !state.adActive) {
          // Finish mode — video done, ad already over — swap back now
          console.log('[BetterAds] Video finished — returning to Twitch');
          finishState.onceActive = false;
          updateFinishToggleUI();
          forceReturnToTwitch();
        } else if (state.adActive || state._swapped) {
          // Ad still running OR still in swap — advance to next video in playlist
          console.log('[BetterAds] Video ended — advancing to next');
          state.smartAdVideoId = null;
          playlist.pickedIndex = null;
          playlist.index = (playlist.index + 1) % (playlist.videos.length || 1);
          loadSmartAd();
        }
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
  state.smartAdVideoId = null;
  playlist.videos = [];
  playlist.index  = 0;
  playlist.pickedIndex = null;
  loadTwitch(channel);
  document.getElementById('watchChannel').textContent = channel;
  closeHub();
  if (state.smartAds) buildPlaylist();
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

// ─── Finish this video ────────────────────────────────────────
const finishState = {
  onceActive: false,
};

function finishThisVideo() {
  if (!state._swapped) return;

  const error = document.getElementById('finishOnceError');

  if (finishState.onceActive) {
    finishState.onceActive = false;
    updateFinishToggleUI();
    if (!state.adActive) {
      unmuteTwitch();
      returnToTwitch();
    }
    return;
  }

  const videoRemaining = state.ytDuration && state.ytCurrent
    ? state.ytDuration - state.ytCurrent : null;
  const adRemaining = state.countdownSecs;

  if (error) {
    if (videoRemaining !== null && adRemaining !== null && videoRemaining < adRemaining) {
      error.style.display = 'flex';
      setTimeout(() => { if (error) error.style.display = 'none'; }, 4000);
    } else {
      error.style.display = 'none';
    }
  }

  finishState.onceActive = true;
  updateFinishToggleUI();
}

function updateFinishToggleUI() {
  const onceToggle = document.getElementById('finishOnceToggle');
  if (onceToggle) onceToggle.setAttribute('aria-pressed', finishState.onceActive);
}

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
  updateSkipBtn();

  if (state.smartAds) {
    // Smart Ads: load contextual video from playlist
    await loadSmartAd();
  } else if (playlist.videos.length) {
    // Manual: use the searched playlist the same way
    await loadSmartAd();
  } else if (state.youtubeId) {
    // Legacy fallback: direct YouTube ID
    ytCommand('playVideo');
    if (state.isLiveStream) {
      setTimeout(() => ytCommandWithArgs('seekTo', [999999, true]), 800);
    }
    startYtProgress();
  }
  // No video configured — overlay shows but blank (user sees countdown at least)
}

function returnToTwitch() {
  if (!state._swapped) return;

  if (finishState.onceActive && !state.adActive) {
    // Track ad as over without unmuting — fight Twitch's auto-unmute
    // by re-muting repeatedly for 2 seconds after ad ends
    let attempts = 0;
    const remuter = setInterval(() => {
      muteTwitch();
      attempts++;
      if (attempts >= 8 || !finishState.onceActive) clearInterval(remuter);
    }, 250);
    updateFinishToggleUI();
    return;
  }

  document.getElementById('ytReturning').style.display = 'block';
  fadeOutYouTube(800, () => {
    if (state.smartAds) {
      clearSmartAd?.();
    } else {
      ytCommand('pauseVideo');
    }
    stopYtProgress();
    unmuteTwitch();
    const overlay = document.getElementById('ytOverlay');
    overlay.style.transition = 'opacity 0.4s ease';
    overlay.classList.remove('visible');
    document.getElementById('ytReturning').style.display = 'none';
    state._swapped         = false;
    finishState.onceActive = false;
    clearCountdown();
    updateFinishToggleUI();
    updateSkipBtn();
    // Restore YouTube volume for next time
    ytCommandWithArgs('setVolume', [100]);
  });
}

function forceReturnToTwitch() {
  finishState.onceActive = false;
  updateFinishToggleUI();
  document.getElementById('ytReturning').style.display = 'block';
  fadeOutYouTube(800, () => {
    ytCommand('pauseVideo');
    stopYtProgress();
    unmuteTwitch();
    const overlay = document.getElementById('ytOverlay');
    overlay.style.transition = 'opacity 0.4s ease';
    overlay.classList.remove('visible');
    document.getElementById('ytReturning').style.display = 'none';
    state._swapped = false;
    clearCountdown();
    ytCommandWithArgs('setVolume', [100]);
  });
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
