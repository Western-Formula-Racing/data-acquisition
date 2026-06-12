# OBS Setup — WFR Streaming Overlay

This recipe captures your local overlay page in OBS and pushes it to YouTube or Twitch as a finished broadcast.

```
[Car Pi] ─ WS :9080 ─┐
                     │
                     ▼
[Laptop] localhost:8000/Streaming Overlay.html   ← telemetry + video composite
                     │
                     ▼
                    OBS  (Browser Source, 1920×1080)
                     │
                     ▼
           rtmp://a.rtmp.youtube.com/live2/<key>
           rtmp://live.twitch.tv/app/<key>
```

---

## 1. Serve the overlay page locally

From the project folder:

```bash
python3 -m http.server 8000
# or:  npx serve .
# or:  npx http-server -p 8000
```

Open `http://localhost:8000/Streaming%20Overlay.html` in a browser to sanity-check it's running.

---

## 2. Add the Browser Source in OBS

1. **Sources** → **+** → **Browser**
2. Name it `WFR Overlay`
3. **URL**: `http://localhost:8000/Streaming%20Overlay.html?variant=B&solo=1`
   - Change `variant=B` to `variant=A` if you want the broadcast-bar variant
   - `solo=1` hides the side-by-side comparison and shows one variant full-bleed
4. **Width**: `1920`
5. **Height**: `1080`
6. **Custom FPS**: ✅ **60**
7. **Custom CSS** (makes the page background transparent so your video shows through the gaps):
   ```css
   html, body, #root { background: transparent !important; }
   ```
8. **Shutdown source when not visible**: ❌ (leave off — keeps telemetry alive)
9. **Refresh browser when scene becomes active**: ✅

Click **OK**. The overlay should now render in OBS at full 1920×1080.

> **Want a pure overlay with no baked video?** Leave the MediaMTX host blank in the Settings panel. The page renders just the overlay chrome on transparent pixels, and you stack a separate OBS Media Source (or Video Capture Device) *underneath* the browser source. This is the recommended setup if your video source is already reliable via OBS directly.

---

## 3. Configure OBS output

**Settings → Output** (Advanced mode):

| Field          | Value                         |
|----------------|-------------------------------|
| Encoder        | NVENC HEVC / H.264 (or x264)  |
| Rate Control   | CBR                           |
| Bitrate        | 6000–9000 kbps (YouTube 1080p60) · 6000 kbps max (Twitch) |
| Keyframe       | 2 s                           |
| Preset         | Quality / P5                  |
| Profile        | high                          |

**Settings → Video**:

| Field                | Value      |
|----------------------|------------|
| Base (Canvas) Res    | 1920×1080  |
| Output (Scaled) Res  | 1920×1080  |
| FPS                  | 60         |

---

## 4. Stream key

**Settings → Stream**:

### YouTube
1. Go to **YouTube Studio → Create → Go Live**.
2. Copy the **Stream key**.
3. OBS → **Settings → Stream** → Service: **YouTube - RTMPS** → paste key.

### Twitch
1. Go to **dashboard.twitch.tv → Settings → Stream**.
2. Copy your **Primary Stream Key**.
3. OBS → **Settings → Stream** → Service: **Twitch** → paste key.

Click **Start Streaming**.

---

## 5. Public viewer page

Open `Public.html` and set your channel IDs at the top of the `<script>` block:

```js
const CONFIG = {
  youtube: {
    channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',   // your channel ID
  },
  twitch: {
    channel:  'wfrracing',
    parents:  ['wfr.example.com'],           // your deployed domain
  },
};
```

- **YouTube channel ID** → [youtube.com/account_advanced](https://www.youtube.com/account_advanced)
- **Twitch parents** → the Twitch player iframe requires a `parent=` param listing the domain(s) hosting the page. For local testing use `['localhost']`; for prod list every domain the page is served from.

Deploy `Public.html` anywhere — it's a single file with no build step. Netlify drop, GitHub Pages, S3, Cloudflare Pages, whatever you like.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| OBS browser source is black | Make sure `python3 -m http.server` is still running. Right-click source → **Refresh**. |
| Overlay looks blurry | Check canvas + output res are both 1920×1080 and FPS is 60. |
| Telemetry stuck on SIM | In the overlay's Settings panel (bottom-right), paste your WS URL and hit **Connect**. Close the panel before capture. |
| Twitch embed shows "refused to connect" | Your domain isn't in `parents`. Add it to `CONFIG.twitch.parents`. |
| YouTube embed shows "video unavailable" | You're not live yet, or the `channelId` is wrong. Once you Start Streaming, it auto-loads. |
| Want to hide the settings panel before capture | Click **HIDE SETTINGS** in the top-right. The panel is OFF by default in `?solo=1` view. |

---

## File map

- `Streaming Overlay.html` — the local page OBS captures
- `Public.html` — the lightweight page your audience visits
- `OBS-SETUP.md` — this file
