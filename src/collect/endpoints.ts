/** URL patterns, captcha signals and the hook message shape shared by hook.ts and content.ts. */

/**
 * API responses the hook forwards. Product data is server-rendered (`__ICE_APP_CONTEXT__`), so no product API
 * is watched; `desc` carries the detail-image description.
 */
export const API_PATTERNS: { product: RegExp[]; reviews: RegExp[]; desc: RegExp[] } = {
  product: [],
  reviews: [/mtop\.taobao\.rate\.detaillist\.get/i],
  desc: [/mtop\.taobao\.detail\.getdesc/i],
};

export const CAPTCHA_RET_CODES = ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR'];
export const CAPTCHA_SELECTORS = ['#baxia-dialog-content', 'iframe[src*="punish"]', '.nc-container', '#nc_1_wrapper'];
export const CAPTCHA_URL = /_____tmd_____\/punish/;

/** `source` of messages posted by the MAIN-world hook. */
export const HOOK_SOURCE = 'tbs-hook';
/** `source` of messages the content script posts to the hook; `{ type: 'replay' }` re-posts everything seen so far. */
export const CONTENT_SOURCE = 'tbs-content';

export type HookKind = 'product' | 'reviews' | 'desc';
export interface HookMessage { source: typeof HOOK_SOURCE; kind: HookKind; url: string; body: unknown }
