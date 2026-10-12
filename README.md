# StreamFilter

Your own Stremio add-on, like Torrentio: pick your debrid service, paste your key, set your filters, install.

- **Debrid services:** TorBox, Real-Debrid, AllDebrid, Premiumize
- **Filters:** cached only, hide HDR / Dolby Vision / CAM, resolutions, min/max size, max results (total and per resolution), sort order, keywords, languages, duplicate removal
- Results come from the torrent source link(s) you add on the setup page. StreamFilter checks them against your debrid account, filters them and gives Stremio instant-play links.

Stream labels: `⚡` cached (plays instantly) · `⏳` not cached · `❔` unknown.
TorBox and Premiumize can check the cache ahead of time. Real-Debrid and AllDebrid no longer allow that, so their results show `❔` — cached ones still start instantly when you press play; uncached ones start downloading on your account.

## Put it online (free)

1. Create a GitHub repository and upload all the files in this folder.
2. On render.com: **New → Web Service** → pick the repo → Runtime **Node**, Build command `true`, Start command `node server.js`, Instance **Free** → Deploy.
3. Open your `https://…onrender.com` link, fill in the page and press **Install in Stremio** (or **Copy link** and paste it into Stremio's add-on search on a TV/phone).

Render's free plan sleeps after 15 minutes idle and takes about a minute to wake up. If the first search after a break comes back empty, try again a moment later.

## Or run it on your computer

`node server.js` (Node 18+) and open http://127.0.0.1:7000. Works for Stremio on the same computer.

## Privacy

Your API key is stored inside your personal install link (that's how Torrentio and similar add-ons work too). Don't share the link.
