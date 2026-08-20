// Deploy-stable version token for static-asset cache busting (ENG-2239).
//
// In production ASSET_VERSION is baked into the image at build time
// (fly/Makefile --build-arg -> fly/docker/app.Dockerfile ENV), so every
// Machine from one deploy mints identical asset URLs and browsers/Cloudflare
// can cache them; the next deploy changes the version and busts the cache.
// Without the env var (dev, docker-compose, tests) fall back to process start
// time: still stable for the life of the process, busts on restart.
module.exports = String(process.env.ASSET_VERSION || Date.now());
