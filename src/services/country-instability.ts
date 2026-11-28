/**
 * Browser-side per-country signal cache for country-detail surfaces and learning-state gating.
 * Published country scores are the Money Bansho index (cached-risk-scores.ts).
 */

import type { ConflictEvent } from './conflict';
import type { CountryDisplacement } from '@/services/displacement';
import type { ClimateAnomaly } from '@/services/climate';
import type { GpsJamHex } from '@/services/gps-interference';
import { CURATED_COUNTRIES } from '@/config/countries';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import { CII_CLIMATE_ZONE_COUNTRIES } from '../../shared/cii-climate-zones';
import { getCountryAtCoordinates, iso3ToIso2Code, nameToCountryCode } from './country-geometry';

/** One country of the Money Bansho instability index, as lists and maps show it. */
export interface CountryScore {
  code: string;
  name: string;
  score: number;
  /** Colour band only: 'normal' below 60, 'elevated' from 60, 'high' from 90. */
  level: 'low' | 'normal' | 'elevated' | 'high' | 'critical';
  /** 90 % interval of the index. */
  low: number | null;
  high: number | null;
  /** Share of the base weight covered by data, 0..1. */
  coverage: number;
  components: ComponentScores;
  lastUpdated: Date | null;
}

/** Component scores in the order of the index; null means no data. */
export type ComponentScores = { id: string; score: number | null }[];

interface CountryData {
  conflicts: ConflictEvent[];
  displacementOutflow: number;
  climateStress: number;
  gpsJammingHighCount: number;
  gpsJammingMediumCount: number;
}

export { TIER1_COUNTRIES } from '@/config/countries';

const LEARNING_DURATION_MS = 15 * 60 * 1000;
let learningStartTime: number | null = null;
let isLearningComplete = false;
let hasCachedScoresAvailable = false;

export function setHasCachedScores(hasScores: boolean): void {
  hasCachedScoresAvailable = hasScores;
  if (hasScores) isLearningComplete = true;
}

export function startLearning(): void {
  if (learningStartTime === null) learningStartTime = Date.now();
}

export function isInLearningMode(): boolean {
  if (hasCachedScoresAvailable || isLearningComplete) return false;
  if (learningStartTime === null) return true;

  if (Date.now() - learningStartTime >= LEARNING_DURATION_MS) {
    isLearningComplete = true;
    return false;
  }
  return true;
}

const countryDataMap = new Map<string, CountryData>();

function initCountryData(): CountryData {
  return {
    conflicts: [],
    displacementOutflow: 0,
    climateStress: 0,
    gpsJammingHighCount: 0,
    gpsJammingMediumCount: 0,
  };
}

export function getCountryData(code: string): CountryData | undefined {
  return countryDataMap.get(code);
}

export type { CountryData };

function normalizeCountryName(name: string): string | null {
  const tokens = tokenizeForMatch(name);
  for (const [code, config] of Object.entries(CURATED_COUNTRIES)) {
    if (config.scoringKeywords.some((keyword) => matchKeyword(tokens, keyword))) return code;
  }
  return nameToCountryCode(name.toLowerCase());
}

export function ingestConflictsForCountryData(events: ConflictEvent[]): void {
  for (const data of countryDataMap.values()) data.conflicts = [];
  for (const event of events) {
    const code = normalizeCountryName(event.country);
    if (!code) continue;
    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.conflicts.push(event);
  }
}

export function ingestDisplacementForCountryData(countries: CountryDisplacement[]): void {
  for (const data of countryDataMap.values()) data.displacementOutflow = 0;

  for (const country of countries) {
    let code: string | null = null;
    if (country.code?.length === 3) code = iso3ToIso2Code(country.code);
    else if (country.code?.length === 2) code = country.code.toUpperCase();
    if (!code) code = nameToCountryCode(country.name);
    if (!code) continue;

    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    countryDataMap.get(code)!.displacementOutflow = country.refugees + country.asylumSeekers;
  }
}

export function ingestClimateForCountryData(anomalies: ClimateAnomaly[]): void {
  for (const data of countryDataMap.values()) data.climateStress = 0;

  for (const anomaly of anomalies) {
    if (anomaly.severity === 'normal') continue;
    const stress = anomaly.severity === 'extreme' ? 15 : 8;
    for (const code of CII_CLIMATE_ZONE_COUNTRIES[anomaly.zone] || []) {
      if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
      const data = countryDataMap.get(code)!;
      data.climateStress = Math.max(data.climateStress, stress);
    }
  }
}

const h3CountryCache = new Map<string, string>();

export function ingestGpsJammingForCountryData(hexes: GpsJamHex[]): void {
  for (const data of countryDataMap.values()) {
    data.gpsJammingHighCount = 0;
    data.gpsJammingMediumCount = 0;
  }

  for (const hex of hexes) {
    let code = h3CountryCache.get(hex.h3);
    if (!code) {
      const country = getCountryAtCoordinates(hex.lat, hex.lon);
      if (!country) continue;
      code = country.code;
      h3CountryCache.set(hex.h3, code);
    }

    if (!countryDataMap.has(code)) countryDataMap.set(code, initCountryData());
    const data = countryDataMap.get(code)!;
    if (hex.level === 'high') data.gpsJammingHighCount += 1;
    else data.gpsJammingMediumCount += 1;
  }
}
