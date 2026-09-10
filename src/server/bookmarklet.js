// bookmarklet.js - the "Add to Orbit" bookmarks-bar button, in the shape of
// golinks' "Add to Golinks". Dragged to the bookmarks bar once, it opens the
// real Orbit app in a tab on a `#add=` deep link for the page the user is on,
// carrying only what the page shows: its address, title, Open Graph
// title/description/site name, and the text the user has selected. The app
// itself drafts the contact (src/shared/page-guess.js) and runs its own
// "Add connection" flow, so nothing is a lesser copy of the app.
//
// The bookmarklet carries the port and nothing else: no token. The window is a
// top-level navigation to our origin, so the session cookie rides along
// (SameSite=Lax; see auth.js), and a browser without a session sees the locked
// page as it would anywhere else. The hash never reaches the server.
//
// A tab, not a popup: the app needs its full width (rail, canvas, card panel),
// and the browser handles focus and placement better than a sized window. The
// target name matches the one the app gives its own window, so a tab this
// button opened earlier is reused where the browser allows (browsers only
// honour a name across tabs that share an opener), else a new tab opens.

const config = require("../main/config");

/** @param {number} port */
function buildBookmarklet(port) {
  const base = `http://localhost:${port}`;
  const src = `(function(){
var d=document;
var m=function(n){var e=d.querySelector('meta[property="'+n+'"],meta[name="'+n+'"]');return e&&e.content?String(e.content).trim():"";};
var s="";try{s=String(window.getSelection()||"").trim().slice(0,${config.bookmarklet.selectionMax});}catch(e){}
var p=new URLSearchParams({url:location.href,title:d.title||"",text:s,og:m("og:title"),desc:m("og:description")||m("description"),site:m("og:site_name")});
var u="${base}/#add="+encodeURIComponent(p.toString());
var w=window.open(u,"${config.bookmarklet.windowName}");
if(!w){location.href=u;}
})();`;
  return "javascript:" + encodeURIComponent(src.replace(/\n/g, ""));
}

module.exports = { buildBookmarklet };
