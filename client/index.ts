/**
 * client/index.ts — single esbuild entry that pulls in every browser-side
 * helper. Each imported module assigns its own window.* global; this file
 * just guarantees they all get included in the bundle.
 */

import './partybus';
import './bankloader';
