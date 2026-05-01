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
  smartAds:       true,
  smartAdVideoId: null,
};

// ─── Favorites ────────────────────────────────────────────────
let favorites = JSON.parse(localStorage.getItem('bc-favorites') || '[]');
function saveFavorites() {
  localStorage.setItem('bc-favorites', JSON.stringify(favorites));
}

// ─── Live status ──────────────────────────────────────────────
const liveStatus = {};
function sortedFavorites() {
  return [...favorites].sort((a, b) => (liveStatus[b] ? 1 : 0) - (liveStatus[a] ? 1 : 0));
}

// ─── Search history ───────────────────────────────────────────
const MAX_HISTORY = 10;
let searchHistory = JSON.parse(localStorage.getItem('ba-search-history') || '[]');

function saveToHistory(query) {
  searchHistory = searchHistory.filter(h => h !== query);
  searchHistory.unshift(query);
  if (searchHistory.length > MAX_HISTORY) searchHistory.pop();
  localStorage.setItem('ba-search-history', JSON.stringify(searchHistory));
}

function deleteFromHistory(query, e) {
  e.stopPropagation();
  searchHistory = searchHistory.filter(h => h !== query);
  localStorage.setItem('ba-search-history', JSON.stringify(searchHistory));
  renderHistoryDropdown(document.getElementById('hubKeywordInput')?.value || '');
}

function renderHistoryDropdown(filter) {
  const el = document.getElementById('hubSearchHistory');
  if (!el) return;
  const matches = filter.trim()
    ? searchHistory.filter(h => h.toLowerCase().includes(filter.toLowerCase()))
    : searchHistory; // show all on empty/focus
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
  btn.style.display = (state._swapped && playlist.videos.length > 1) ? 'flex' : 'none';
}

// ─── Finish this video ────────────────────────────────────────
const finishState = { onceActive: false };

function finishThisVideo() {
  if (!state._swapped) return;
  const error = document.getElementById('finishOnceError');
  if (finishState.onceActive) {
    finishState.onceActive = false;
    updateFinishToggleUI();
    if (!state.adActive) { unmuteTwitch(); returnToTwitch(); }
    return;
  }
  const videoRemaining = (state.ytDuration && state.ytCurrent)
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

// ─── Smart Ads playlist ───────────────────────────────────────
const playlist = {
  pool:         [], // all fetched videos (up to 20)
  videos:       [], // currently active 5 shown in carousel
  index:        0,
  pickedIndex:  null,
  refreshTimer: null,
  queryIndex:   0,
};

function populateFromPool() {
  // Pick 5 randomly from pool that aren't already in active videos
  const activeIds = new Set(playlist.videos.map(v => v.id));
  const available = playlist.pool.filter(v => !activeIds.has(v.id));
  const shuffled  = available.sort(() => Math.random() - 0.5);
  playlist.videos = [...playlist.videos, ...shuffled].slice(0, 5);
}

function rejectCurrentVideo() {
  if (!playlist.videos.length) return;
  // Remove current video from active list and pool
  const rejected = playlist.videos[playlist.index];
  playlist.pool   = playlist.pool.filter(v => v.id !== rejected.id);
  playlist.videos.splice(playlist.index, 1);

  // Pull replacement from remaining pool if available
  const activeIds = new Set(playlist.videos.map(v => v.id));
  const available = playlist.pool.filter(v => !activeIds.has(v.id));
  if (available.length) {
    const replacement = available[Math.floor(Math.random() * available.length)];
    playlist.videos.push(replacement);
  }

  // Adjust index if we removed the last item
  if (playlist.index >= playlist.videos.length) {
    playlist.index = Math.max(0, playlist.videos.length - 1);
  }

  // If current was the picked one, clear pick
  if (playlist.pickedIndex === playlist.index) playlist.pickedIndex = null;

  // If rejected video was playing, load next
  if (state.smartAdVideoId === rejected.id) {
    state.smartAdVideoId = null;
    if (state._swapped) loadSmartAd();
  }

  renderCarousel();
  renderHubYouTube();
}

const QUERY_VARIANTS = [
  g => `${g} highlights`,
  g => `${g} best moments`,
  g => `${g} funny clips`,
  g => `${g} gameplay`,
  g => `${g} montage`,
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

  const query = QUERY_VARIANTS[playlist.queryIndex % QUERY_VARIANTS.length](lastGame);
  console.log('[BetterAds] Playlist query:', query);

  const res = await searchYouTubeViaWorker(query, 5);
  if (loading) loading.style.display = 'none';
  if (!res?.pool?.length) return;

  playlist.pool        = res.pool;
  playlist.videos      = res.videos;
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
  playlist.queryIndex  = (playlist.queryIndex + 1) % QUERY_VARIANTS.length;
  playlist.pickedIndex = null;
  state.smartAdVideoId = null;
  await buildPlaylist();
}

async function rejectVideo() {
  if (!playlist.videos.length) return;

  const btn = document.querySelector('.playlist-reject-btn');
  if (btn) btn.classList.add('loading');

  // Remove current video from list
  const rejectedId = playlist.videos[playlist.index]?.id;
  playlist.videos.splice(playlist.index, 1);

  // Adjust index if we were at the end
  if (playlist.index >= playlist.videos.length && playlist.index > 0) {
    playlist.index = playlist.videos.length - 1;
  }

  // Fetch one replacement — get 20, filter out existing IDs, pick 1
  const existingIds = new Set(playlist.videos.map(v => v.id));
  if (rejectedId) existingIds.add(rejectedId);

  const query = QUERY_VARIANTS[playlist.queryIndex % QUERY_VARIANTS.length](lastGame);
  const res   = await searchYouTubeViaWorker(query, 5);

  if (res?.length) {
    // Pick first result not already in playlist
    const fresh = res.find(v => !existingIds.has(v.id));
    if (fresh) playlist.videos.push(fresh);
  }

  if (btn) btn.classList.remove('loading');
  renderCarousel();
  renderHubYouTube();
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
  if (thumbWrap) thumbWrap.classList.toggle('smart-active-border', state.smartAds);
  if (pickBtn) {
    const isPicked = playlist.pickedIndex === playlist.index;
    pickBtn.textContent = isPicked ? '✓ selected' : '✓ use this one';
    pickBtn.classList.toggle('picked', isPicked);
  }
}

function parseIsoDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h = parseInt(m[1]||0), min = parseInt(m[2]||0), s = parseInt(m[3]||0);
  return h > 0
    ? `${h}:${String(min).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${min}:${String(s).padStart(2,'0')}`;
}

function parseDurationSecs(iso) {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
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
  if (state._swapped && state.smartAds) loadSmartAd();
}

function getPlaylistVideo() {
  if (playlist.pickedIndex !== null && playlist.videos[playlist.pickedIndex])
    return playlist.videos[playlist.pickedIndex];
  if (!playlist.videos.length) return null;
  return playlist.videos[Math.floor(Math.random() * playlist.videos.length)];
}

// ─── Smart Ads ────────────────────────────────────────────────
function toggleSmartAds() {
  state.smartAds = !state.smartAds;
  const btn = document.getElementById('smartAdsToggle');
  if (btn) btn.setAttribute('aria-pressed', state.smartAds);
  localStorage.setItem('ba-smart-ads', state.smartAds);
  if (state.smartAds && state.channel) {
    state.smartAdVideoId = null;
    playlist.videos = []; playlist.index = 0; playlist.pickedIndex = null;
    buildPlaylist();
  }
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
  renderHubYouTube();
}

function toggleSmartAdsHub() {
  toggleSmartAds();
  syncHubSmartToggle();
  renderHubYouTube();
}

function syncHubSmartToggle() {
  const t = document.getElementById('hubSmartToggle');
  if (t) t.setAttribute('aria-pressed', state.smartAds);
}

function renderHubYouTube() {
  const smartSection  = document.getElementById('hubSmartSection');
  const manualSection = document.getElementById('hubManualSection');
  const carousel      = document.getElementById('playlistCarousel');
  const smartEmpty    = document.getElementById('hubSmartEmpty');
  const thumbWrap     = document.getElementById('playlistThumbWrap');
  const keywordRow    = document.querySelector('.hub-keyword-row');
  const keywordHint   = document.querySelector('.hub-keyword-hint');

  if (smartSection)  smartSection.classList.remove('hub-section-grayed');
  if (manualSection) manualSection.classList.remove('hub-section-grayed');
  if (keywordRow)    keywordRow.classList.toggle('hub-section-grayed', state.smartAds);
  if (keywordHint)   keywordHint.classList.toggle('hub-section-grayed', state.smartAds);
  if (thumbWrap)     thumbWrap.classList.toggle('smart-active-border', state.smartAds);

  if (playlist.videos.length) {
    if (carousel)   carousel.style.display  = 'flex';
    if (smartEmpty) smartEmpty.style.display = 'none';
  } else {
    if (carousel)   carousel.style.display  = 'none';
    if (smartEmpty) smartEmpty.style.display = state.smartAds ? 'block' : 'none';
  }
  syncHubSmartToggle();
}

async function fetchStreamGame(channel) {
  try {
    const res = await fetch(TWITCH_GQL, {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        operationName: 'UsersInfo',
        variables:     { logins: [channel] },
        query: `query UsersInfo($logins: [String!]!) {
          users(logins: $logins) { login stream { title game { name } } }
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
    const res  = await fetch(`${WORKER_URL}?q=${encodeURIComponent(query)}&max=20`);
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
    const shuffled = mapped.sort(() => Math.random() - 0.5);
    // Return object with full pool and active slice
    return { pool: shuffled, videos: shuffled.slice(0, maxResults) };
  } catch (_) { return null; }
}

async function loadSmartAd() {
  if (state.smartAdVideoId) {
    ytCommand('playVideo');
    startYtProgress();
    const label = document.getElementById('ytAdLabel');
    if (label) {
      const cur = playlist.videos.find(v => v.id === state.smartAdVideoId);
      if (cur) label.textContent = `▶ ${cur.title.slice(0,45)}${cur.title.length>45?'…':''}`;
    }
    return;
  }
  let video = getPlaylistVideo();
  if (!video) {
    const countdownEl = document.getElementById('ytCountdown');
    if (countdownEl) countdownEl.textContent = 'finding...';
    const streamInfo = await fetchStreamGame(state.channel);
    const q = streamInfo?.game ? `${streamInfo.game} highlights` : 'gaming highlights';
    const results = await searchYouTubeViaWorker(q, 5);
    if (countdownEl) countdownEl.textContent = '';
    if (results?.pool?.length) {
      playlist.pool   = results.pool;
      playlist.videos = results.videos;
      video = results.videos[0];
    }
  }
  if (!video) {
    const saved = localStorage.getItem('ba-manual-keywords');
    if (saved) {
      const r = await searchYouTubeViaWorker(saved, 5);
      if (r?.pool?.length) {
        playlist.pool   = r.pool;
        playlist.videos = r.videos;
        video = r.videos[0];
      }
    }
    if (!video) return;
  }
  console.log('[BetterAds] Loading:', video.title);
  state.smartAdVideoId = video.id;
  document.getElementById('youtubeFrame').src =
    `https://www.youtube.com/embed/${video.id}?enablejsapi=1&autoplay=1`;
  startYtProgress();
  const label = document.getElementById('ytAdLabel');
  if (label) label.textContent = `▶ ${video.title.slice(0,45)}${video.title.length>45?'…':''}`;
}

async function searchManualPlaylist() {
  const input = document.getElementById('hubKeywordInput');
  const query = input?.value.trim();
  if (!query) return;
  saveToHistory(query);
  const el = document.getElementById('hubSearchHistory');
  if (el) el.style.display = 'none';
  localStorage.setItem('ba-manual-keywords', query);

  const loading = document.getElementById('playlistLoading');
  const carousel = document.getElementById('playlistCarousel');
  if (carousel) carousel.style.display = 'flex';
  if (loading)  loading.style.display  = 'flex';

  const res = await searchYouTubeViaWorker(query, 5);
  if (loading) loading.style.display = 'none';
  if (!res?.pool?.length) return;

  playlist.pool        = res.pool;
  playlist.videos      = res.videos;
  playlist.index       = 0;
  playlist.pickedIndex = null;
  state.smartAdVideoId = null;
  renderCarousel();
  renderHubYouTube();
}

async function searchWithKeywords(query) {
  const loading = document.getElementById('playlistLoading');
  const carousel = document.getElementById('playlistCarousel');
  if (carousel) carousel.style.display = 'flex';
  if (loading)  loading.style.display  = 'flex';
  const res = await searchYouTubeViaWorker(query, 5);
  if (loading) loading.style.display = 'none';
  if (!res?.pool?.length) return;
  playlist.pool   = res.pool;
  playlist.videos = res.videos;
  playlist.index  = 0;
  playlist.pickedIndex = null;
  renderCarousel();
  renderHubYouTube();
}

// ─── Setup ────────────────────────────────────────────────────
function startWatching(channel) {
  const channelVal = (channel || document.getElementById('twitchInput').value.trim()).toLowerCase();
  if (!channelVal) { shake('twitchInput'); return; }

  const keywordVal = document.getElementById('youtubeInput')?.value.trim() || '';
  if (keywordVal && !state.smartAds) localStorage.setItem('ba-manual-keywords', keywordVal);

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
    const saved = localStorage.getItem('ba-manual-keywords');
    if (saved) searchWithKeywords(saved);
  }
}

function loadTwitch(channel) {
  const savedVol = localStorage.getItem('ba-twitch-volume');
  const vol = savedVol !== null ? parseFloat(savedVol) : 1.0;
  document.getElementById('twitchFrame').src =
    `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${location.hostname}&autoplay=true&volume=${vol}`;
}

function isLiveStreamUrl(url) {
  return /youtube\.com\/live\//i.test(url) || /youtube\.com\/@[^/]+\/live/i.test(url);
}

function loadYouTube(id, originalUrl) {
  state.youtubeId    = id;
  state.isLiveStream = originalUrl ? isLiveStreamUrl(originalUrl) : false;
  document.getElementById('youtubeFrame').src =
    `https://www.youtube.com/embed/${id}?enablejsapi=1&autoplay=0`;
}

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
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

function shake(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.classList.add('error');
  el.animate([
    {transform:'translateX(0)'},{transform:'translateX(-6px)'},
    {transform:'translateX(6px)'},{transform:'translateX(-4px)'},{transform:'translateX(0)'},
  ], {duration:300, easing:'ease-out'});
  setTimeout(() => el.classList.remove('error'), 2000);
}

function goBack() {
  clearCountdown();
  stopLivePolling();
  stopYtProgress();
  document.getElementById('twitchFrame').src = 'about:blank';
  document.getElementById('youtubeFrame').src = 'about:blank';
  resetChatFrame();
  hideYouTube(false);
  window.removeEventListener('message', onMessage);
  state.adActive  = false;
  state._swapped  = false;
  state.channel   = '';
  state.youtubeId = '';
  state.smartAdVideoId = null;
  playlist.videos = []; playlist.index = 0; playlist.pickedIndex = null;
  if (playlist.refreshTimer) { clearInterval(playlist.refreshTimer); playlist.refreshTimer = null; }
  finishState.onceActive = false;
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

// ─── Mute/unmute Twitch ───────────────────────────────────────
function muteTwitch() {
  try {
    document.getElementById('twitchFrame').contentWindow.postMessage(
      JSON.stringify({ eventName: 'mute', params: { muted: true } }), '*'
    );
  } catch (_) {}
}

function unmuteTwitch() {
  try {
    document.getElementById('twitchFrame').contentWindow.postMessage(
      JSON.stringify({ eventName: 'mute', params: { muted: false } }), '*'
    );
  } catch (_) {}
}

// ─── YouTube fade out ─────────────────────────────────────────
function fadeOutYouTube(duration, done) {
  const steps = 20, interval = duration / steps;
  let step = 0;
  const timer = setInterval(() => {
    step++;
    try { ytCommandWithArgs('setVolume', [Math.round(Math.max(0, 1 - step/steps) * 100)]); } catch(_) {}
    if (step >= steps) { clearInterval(timer); if (done) done(); }
  }, interval);
}

// ─── YouTube overlay ──────────────────────────────────────────
async function showYouTube(duration) {
  state._swapped = true;
  document.getElementById('ytOverlay').classList.add('visible');
  document.getElementById('ytReturning').style.display = 'none';
  if (duration) startCountdown(duration);
  updateSkipBtn();

  if (state.smartAds || playlist.videos.length) {
    await loadSmartAd();
  } else if (state.youtubeId) {
    ytCommand('playVideo');
    if (state.isLiveStream) setTimeout(() => ytCommandWithArgs('seekTo', [999999, true]), 800);
    startYtProgress();
  }
}

function returnToTwitch() {
  if (!state._swapped) return;

  if (finishState.onceActive && !state.adActive) {
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
    ytCommand('pauseVideo');
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
    updateSkipBtn();
    ytCommandWithArgs('setVolume', [100]);
  });
}

function hideYouTube(animate) {
  const overlay = document.getElementById('ytOverlay');
  if (animate) overlay.style.transition = 'opacity 0.6s ease';
  overlay.classList.remove('visible');
  document.getElementById('ytReturning').style.display = 'none';
  document.getElementById('ytCountdown').textContent = '';
  updateSkipBtn();
}

// ─── YouTube postMessage API ──────────────────────────────────
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

// ─── YouTube progress (only runs during ad swap) ──────────────
// Cache element reference to avoid repeated DOM queries
let ytFrame = null;
function getYtFrame() {
  if (!ytFrame) ytFrame = document.getElementById('youtubeFrame');
  return ytFrame;
}

function startYtProgress() {
  stopYtProgress();
  state.ytProgressTimer = setInterval(() => {
    try {
      getYtFrame().contentWindow.postMessage(
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

// ─── YouTube message listener ─────────────────────────────────
window.addEventListener('message', e => {
  if (!e.data) return;
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (data.event === 'infoDelivery' && data.info) {
      if (data.info.duration !== undefined)     state.ytDuration   = data.info.duration;
      if (data.info.currentTime !== undefined)  state.ytCurrent    = data.info.currentTime;
      if (data.info.isLive !== undefined)       state.isLiveStream = !!data.info.isLive;

      if (data.info.playerState === 0 && state._swapped) {
        if (finishState.onceActive && !state.adActive) {
          finishState.onceActive = false;
          updateFinishToggleUI();
          forceReturnToTwitch();
        } else if (state._swapped) {
          state.smartAdVideoId = null;
          playlist.pickedIndex = null;
          playlist.index = (playlist.index + 1) % (playlist.videos.length || 1);
          loadSmartAd();
        }
      }
    }
  } catch (_) {}
});

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
  document.getElementById('ytCountdown').textContent =
    `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

// ─── Ad handling ──────────────────────────────────────────────
function onMessage(e) {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.source === 'betterads-extension' && e.data.type === 'ba-ready') {
    extDetected = true;
    clearTimeout(extCheckTimer);
    document.getElementById('extWarning').style.display = 'none';
    return;
  }
  if (e.data.source !== 'betterads-extension' && e.data.source !== 'gridview-extension') return;
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
    showYouTube(duration);
  } else {
    returnToTwitch();
  }
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

// ─── Favorites ────────────────────────────────────────────────
function renderFavorites() {
  const container = document.getElementById('hubFavorites');
  if (!container) return;
  container.innerHTML = '';
  if (favorites.length === 0) {
    container.innerHTML = `<div style="font-family:var(--font-mono);font-size:10px;color:var(--muted);padding:4px 0;">no favorites yet</div>`;
    return;
  }
  sortedFavorites().forEach(ch => {
    const i = favorites.indexOf(ch);
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
  const val = document.getElementById('favInput')?.value.trim().toLowerCase();
  if (!val || favorites.includes(val)) {
    if (document.getElementById('favInput')) document.getElementById('favInput').value = '';
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
  playlist.videos = []; playlist.index = 0; playlist.pickedIndex = null;
  loadTwitch(channel);
  resetChatFrame();
  document.getElementById('watchChannel').textContent = channel;
  closeHub();
  if (state.smartAds) buildPlaylist();
}

// ─── Live status ──────────────────────────────────────────────
let liveTimer = null;

function startLivePolling() {
  stopLivePolling();
  checkAllLive();
  liveTimer = setInterval(checkAllLive, 60000);
}

function stopLivePolling() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

async function checkAllLive() {
  if (!favorites.length) return;
  const queries = favorites.map(ch => ({
    operationName: 'UsersInfo',
    variables:     { logins: [ch] },
    query: `query UsersInfo($logins: [String!]!) { users(logins: $logins) { login stream { id } } }`,
  }));
  try {
    const res  = await fetch(TWITCH_GQL, {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify(queries),
    });
    if (!res.ok) return;
    const data    = await res.json();
    const results = Array.isArray(data) ? data : [data];
    results.forEach((item, i) => {
      const ch     = favorites[i];
      const isLive = !!(item?.data?.users?.[0]?.stream);
      setLiveDot(ch, isLive);
    });
  } catch (_) {}
}

function setLiveDot(channel, isLive) {
  const changed = liveStatus[channel] !== isLive;
  liveStatus[channel] = isLive;
  const dot     = document.getElementById(`fav-dot-${channel}`);
  const setupDot = document.getElementById(`setup-dot-${channel}`);
  if (dot)      { dot.classList.toggle('live', isLive); dot.title = isLive ? `${channel} is live` : `${channel} is offline`; }
  if (setupDot) setupDot.classList.toggle('live', isLive);
  if (changed)  { renderFavorites(); renderSetupDock(); }
}

// ─── Setup dock ───────────────────────────────────────────────
function renderSetupDock() {
  const dock     = document.getElementById('setupDock');
  const channels = document.getElementById('setupDockChannels');
  if (!dock || !channels) return;
  if (!favorites.length) { dock.style.display = 'none'; return; }
  dock.style.display = 'flex';
  channels.innerHTML = '';
  sortedFavorites().forEach(ch => {
    const chip = document.createElement('div');
    chip.className = 'setup-dock-chip';
    chip.id        = `setup-chip-${ch}`;
    chip.innerHTML = `<span class="setup-dock-chip-dot${liveStatus[ch] ? ' live' : ''}" id="setup-dot-${ch}"></span>${ch}`;
    chip.onclick   = () => quickStart(ch);
    channels.appendChild(chip);
  });
  checkAllLive();
}

function quickStart(channel) {
  document.getElementById('twitchInput').value = channel;
  startWatching();
}

let toastTimer = null;
function showToast() {
  const toast = document.getElementById('setupToast');
  if (toast) toast.style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toast) toast.style.display = 'none'; }, 3000);
}

// ─── Event delegation ─────────────────────────────────────────
// Enter key on capture phase — intercepts before Twitch iframe steals it
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && chatBarOpen) { closeChatBar(); e.preventDefault(); return; }

  const tag      = document.activeElement?.tagName;
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' ||
                   document.activeElement?.contentEditable === 'true';

  if (e.key === 'Enter' && !isTyping && !e.repeat) {
    if (document.getElementById('watchScreen')?.style.display !== 'none') {
      chatBarOpen ? closeChatBar() : openChatBar();
      e.preventDefault();
      return;
    }
  }

  if (e.key !== 'Enter') return;
  const id = e.target?.id;
  if (id === 'favInput')        addFavorite();
  if (id === 'hubKeywordInput') searchManualPlaylist();
}, true); // capture: true — fires before iframe

document.addEventListener('input', e => {
  if (e.target?.id === 'hubKeywordInput') renderHistoryDropdown(e.target.value);
});

document.addEventListener('focusin', e => {
  if (e.target?.id === 'hubKeywordInput') {
    // Show all history on focus if input is empty, filtered if not
    renderHistoryDropdown(e.target.value);
  }
});

document.addEventListener('click', e => {
  if (!e.target?.closest('.hub-keyword-wrap')) {
    const el = document.getElementById('hubSearchHistory');
    if (el) el.style.display = 'none';
  }
});

// Dim YouTube input based on smart ads state
document.getElementById('youtubeInput').addEventListener('input', () => {
  const input = document.getElementById('youtubeInput');
  if (state.smartAds) input.classList.toggle('smart-active', !input.value.trim());
});

document.getElementById('twitchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('youtubeInput').focus();
});

document.getElementById('youtubeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startWatching();
});

// ─── Chat ─────────────────────────────────────────────────────
let chatBarOpen    = false;
let chatFrameReady = false;

function openChatBar() {
  if (!state.channel) return;
  const bar   = document.getElementById('chatBar');
  const frame = document.getElementById('chatFrame');
  if (!bar || !frame) return;

  if (!chatFrameReady) {
    frame.src = `https://www.twitch.tv/embed/${state.channel}/chat?parent=${location.hostname}`;
    chatFrameReady = true;
  }

  bar.style.display = 'block';
  chatBarOpen = true;
  setTimeout(() => frame.focus(), 150);
}

function closeChatBar() {
  const bar = document.getElementById('chatBar');
  if (bar) bar.style.display = 'none';
  chatBarOpen = false;
}

function resetChatFrame() {
  const frame = document.getElementById('chatFrame');
  if (frame) frame.src = 'about:blank';
  chatFrameReady = false;
  chatBarOpen    = false;
  closeChatBar();
}

// ─── Dev helpers ──────────────────────────────────────────────
window.simulateAd = (isAd, duration) => handleAd(isAd, duration || null);

// ─── Init ─────────────────────────────────────────────────────
const savedSmartAds = localStorage.getItem('ba-smart-ads');
state.smartAds = savedSmartAds === null ? true : savedSmartAds === 'true';
localStorage.setItem('ba-smart-ads', state.smartAds);

const toggleBtn = document.getElementById('smartAdsToggle');
if (toggleBtn) toggleBtn.setAttribute('aria-pressed', state.smartAds);

const ytInput = document.getElementById('youtubeInput');
ytInput.value = '';
if (state.smartAds) {
  ytInput.classList.add('smart-active');
  ytInput.placeholder = 'smart ads on — keywords optional';
} else {
  ytInput.placeholder = 'e.g. lofi music chill beats...';
}

renderSetupDock();
