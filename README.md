# BetterAds

Watch Twitch. Skip the ads.

BetterAds replaces Twitch ad breaks with YouTube videos — automatically or from your own search. When the ad ends, it returns to your stream seamlessly.

---

## Setup

### Step 1 — Load the Extension

The extension detects when a Twitch ad starts and triggers the YouTube swap.

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Navigate to the `extension/` folder and select `manifest.json`
4. You should see **BetterAds** appear in the list

> The extension must be reloaded each time Firefox restarts. For a permanent install, the extension would need to be signed by Mozilla.

---

### Step 2 — Allow Twitch Cookies (for Chat)

Required only if you want to use the chat feature. This allows the Twitch chat iframe to access your Twitch login session.

1. Go to `about:preferences#privacy`
2. Under **Enhanced Tracking Protection**, click **Manage Exceptions...**
3. Enter `https://notkle.github.io` and click **Allow**
4. Click **Save Changes**

> This is a one-time setup. Without it, the chat bar will load but you won't be logged in.

---

## Usage

### Watching
- Go to [notkle.github.io/BetterAds](https://notkle.github.io/BetterAds)
- Enter a Twitch channel name and click **Start Watching**
- Ads are detected and replaced automatically

### Smart Ads
- Toggle on the setup screen (default: ON)
- Automatically searches YouTube for content related to the stream's current game
- Browse the playlist in the hub before an ad hits

### Manual Search
- Open the hub (hover right edge) → type keywords → press Search
- Results populate the same carousel as Smart Ads

### Chat
- Press **Enter** while watching to open the chat bar
- Type your message and press **Enter** to send and close
- Press **Esc** to close without sending

### Hub
- Hover the right edge of the screen to open
- Contains: ad break video preview, favorites, keyword search, finish this video toggle

### Favorites
- Add channels in the hub → they appear as quick-start chips on the setup screen
- Live channels sort to the top automatically

---

## Notes

- Firefox only (extension uses WebExtensions API)
- The extension is temporary — reload it at `about:debugging` after each Firefox restart
- Smart Ads requires an active internet connection to the YouTube search proxy
- Chat requires the cookie exception from Step 2 above
