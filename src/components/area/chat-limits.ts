/**
 * Shared composer limits — imported by both the docked composer
 * (chat-workspace) and the Home composer (home-dashboard) so they can never
 * drift from each other or from the server-side bound in POST /api/chat.
 */

/** Mirrors MAX_MESSAGE_CHARS server-side (POST /api/chat). */
export const MAX_MESSAGE_CHARS = 8000;
/** The composer counter appears once the draft approaches the limit. */
export const CHAR_COUNTER_AT = 7000;
