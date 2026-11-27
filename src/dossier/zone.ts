// Which calendar day a daily bar belongs to. Yahoo stamps each bar with the session open; on
// exchanges east of UTC+9 (Sydney, Auckland) the open falls on the previous UTC date, so the UTC
// date of the stamp is not the trading day there. The offset of the exchange on screen
// (gmtoffset: seconds east of UTC, sent with the dossier) moves a stamp onto its local date.
const DAY = 86_400_000;
const MAX_OFFSET_S = 14 * 3600;

let offsetMs = 0;

/** Sets the exchange of the company on screen; null (wire, screener) means UTC. */
export function setBarOffset(seconds: number | null | undefined): void {
  offsetMs =
    typeof seconds === 'number' && Number.isFinite(seconds) && Math.abs(seconds) <= MAX_OFFSET_S ? seconds * 1000 : 0;
}

/**
 * The timestamp to format in UTC so that the printed date is the exchange-local one. Whole UTC
 * days (series keyed by day, month starts) already are calendar dates and stay as they are.
 */
export const exchangeDay = (time: number): number => (time % DAY === 0 ? time : time + offsetMs);
