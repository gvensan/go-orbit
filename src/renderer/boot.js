// boot.js - renderer entry point. web-api.js installs window.api first (app.js
// reads it at module evaluation); all real logic lives in app.js.

import "./web-api.js";
import { init } from "./app.js";

init();
