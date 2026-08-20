/**
 * functions/gamer/[code].ts — GET /gamer/:房號 → 302 /gamer?room=房號
 *
 * 「語意化、好記」版的參賽者加入短連結,行為與 /r/:房號 完全相同。
 * 為什麼不能寫在 _redirects、房號格式規則,見 functions/r/[code].ts。
 * 注意:不帶房號的 /gamer 仍由 _redirects rewrite 到 participant.html,
 * 不會進到這裡(此 route 只吃 /gamer/<一段路徑> 的請求)。
 */

import { roomRedirect } from '../_shared';

export const onRequestGet: PagesFunction = async (context) => {
  return roomRedirect(context.params.code);
};
