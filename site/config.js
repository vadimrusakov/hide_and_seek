// Seek Map configuration. The Firebase web config is not secret: access is controlled by the
// Realtime Database rules (see database.rules.json).
window.SEEK_CONFIG = {
  firebase: {
    apiKey: "AIzaSyC92Sb7cHdmQhgX1-z7bLqE6ObrLvVONJM",
    authDomain: "edinburgh-hide-seek.firebaseapp.com",
    databaseURL: "https://edinburgh-hide-seek-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "edinburgh-hide-seek",
    storageBucket: "edinburgh-hide-seek.firebasestorage.app",
    messagingSenderId: "498841495306",
    appId: "1:498841495306:web:555762c7e8a9a3fbfdfcf3"
  },
  // Add a region by generating regions/<id>.json with build_region.py and listing it here.
  regions: [
    { id: "edinburgh", name: "Edinburgh", file: "regions/edinburgh.json" }
  ],
  defaults: { radius: 500, safety: true, hideMin: 45, ansMin: 5, photoMin: 10 }
};
