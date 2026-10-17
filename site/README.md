# Seek Map

Hide-and-seek helper for Jet Lag style games. Static site + Firebase Realtime Database.

## Files
- index.html, app.js, app.css: the app
- config.js: Firebase config and the list of regions
- regions/edinburgh.json: Edinburgh region pack (boundary, safety zones, stops, place lists)
- database.rules.json: paste into Firebase console > Realtime Database > Rules

## Deploy
Drag this whole folder onto Netlify Drop (app.netlify.com/drop), or push it to GitHub Pages.
It must be served over https for location to work.

## New region
Run src/build_region.py with OSM extracts for the new area, save regions/<id>.json,
and add it to `regions` in config.js.
