/**
 * functions/r/[code].ts — GET /r/:房號 → 302 /gamer?room=房號
 *
 * 參賽者加入短連結(QR Code 用)。原本寫在 public/_redirects:
 *   /r/:code  /gamer?room=:code  302
 * 但 Cloudflare Pages 的 _redirects placeholder 只代換目的地的「路徑」段,
 * 放在 query string 裡不會代換 —— 實際回應是 Location: /gamer?room=%3Acode
 * (字面值 ":code"),所有掃 QR / 打短網址的人都被導進同一個叫 ":code" 的
 * 幽靈房,跟助理端的真房間永遠對不上(2026-08-20 現場事故)。
 * 改用 Pages Function 做真正的代換。_redirects 的比對先於 Functions,
 * 所以那兩條規則已刪除,請勿加回 _redirects。
 */

import { roomRedirect } from '../_shared';

export const onRequestGet: PagesFunction = async (context) => {
  return roomRedirect(context.params.code);
};
