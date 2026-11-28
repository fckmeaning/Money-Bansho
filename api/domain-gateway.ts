// Money Bansho demo deployment: one Edge function for every dashboard data domain.
//
// Vercel Hobby allows 12 functions per deployment, so most per-domain files
// (api/<domain>/v1/[rpc].ts) are excluded in .vercelignore and their routes are
// served from here through the rewrite in vercel.json. A dynamic `[domain]`
// folder is not used: on Vercel it also captured the four folders below.
// news, market, intelligence and displacement keep their own
// files: together they would not fit the 1 MB (gzip) Edge function limit.
// Each request goes through the same gateway as in the per-domain files: CORS,
// API key or session, rate limits.
// `npm run dev` does the same job with sebufApiPlugin() in vite.config.ts.
//
// Left out on purpose: feedback and leads (accept submissions), batch and
// scenario (fan-out and job queue), orbital (switched off by default).

export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

import { createDomainGateway, serverOptions } from '../server/gateway';
import { restoreDomainRequest } from './_domain-rewrite';

import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server';
import { createClimateServiceRoutes } from '../src/generated/server/worldmonitor/climate/v1/service_server';
import { createConflictServiceRoutes } from '../src/generated/server/worldmonitor/conflict/v1/service_server';
import { createConsumerPricesServiceRoutes } from '../src/generated/server/worldmonitor/consumer_prices/v1/service_server';
import { createCyberServiceRoutes } from '../src/generated/server/worldmonitor/cyber/v1/service_server';
import { createEconomicServiceRoutes } from '../src/generated/server/worldmonitor/economic/v1/service_server';
import { createForecastServiceRoutes } from '../src/generated/server/worldmonitor/forecast/v1/service_server';
import { createGivingServiceRoutes } from '../src/generated/server/worldmonitor/giving/v1/service_server';
import { createHealthServiceRoutes } from '../src/generated/server/worldmonitor/health/v1/service_server';
import { createImageryServiceRoutes } from '../src/generated/server/worldmonitor/imagery/v1/service_server';
import { createInfrastructureServiceRoutes } from '../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { createMaritimeServiceRoutes } from '../src/generated/server/worldmonitor/maritime/v1/service_server';
import { createMilitaryServiceRoutes } from '../src/generated/server/worldmonitor/military/v1/service_server';
import { createNaturalServiceRoutes } from '../src/generated/server/worldmonitor/natural/v1/service_server';
import { createPositiveEventsServiceRoutes } from '../src/generated/server/worldmonitor/positive_events/v1/service_server';
import { createPredictionServiceRoutes } from '../src/generated/server/worldmonitor/prediction/v1/service_server';
import { createRadiationServiceRoutes } from '../src/generated/server/worldmonitor/radiation/v1/service_server';
import { createResearchServiceRoutes } from '../src/generated/server/worldmonitor/research/v1/service_server';
import { createResilienceServiceRoutes } from '../src/generated/server/worldmonitor/resilience/v1/service_server';
import { createSafetyServiceRoutes } from '../src/generated/server/worldmonitor/safety/v1/service_server';
import { createSanctionsServiceRoutes } from '../src/generated/server/worldmonitor/sanctions/v1/service_server';
import { createScorecardServiceRoutes } from '../src/generated/server/worldmonitor/scorecard/v1/service_server';
import { createSeismologyServiceRoutes } from '../src/generated/server/worldmonitor/seismology/v1/service_server';
import { createSupplyChainServiceRoutes } from '../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { createThermalServiceRoutes } from '../src/generated/server/worldmonitor/thermal/v1/service_server';
import { createTradeServiceRoutes } from '../src/generated/server/worldmonitor/trade/v1/service_server';
import { createUnrestServiceRoutes } from '../src/generated/server/worldmonitor/unrest/v1/service_server';
import { createWebcamServiceRoutes } from '../src/generated/server/worldmonitor/webcam/v1/service_server';
import { createWildfireServiceRoutes } from '../src/generated/server/worldmonitor/wildfire/v1/service_server';

import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler';
import { climateHandler } from '../server/worldmonitor/climate/v1/handler';
import { conflictHandler } from '../server/worldmonitor/conflict/v1/handler';
import { consumerPricesHandler } from '../server/worldmonitor/consumer-prices/v1/handler';
import { cyberHandler } from '../server/worldmonitor/cyber/v1/handler';
import { economicHandler } from '../server/worldmonitor/economic/v1/handler';
import { forecastHandler } from '../server/worldmonitor/forecast/v1/handler';
import { givingHandler } from '../server/worldmonitor/giving/v1/handler';
import { healthHandler } from '../server/worldmonitor/health/v1/handler';
import { imageryHandler } from '../server/worldmonitor/imagery/v1/handler';
import { infrastructureHandler } from '../server/worldmonitor/infrastructure/v1/handler';
import { maritimeHandler } from '../server/worldmonitor/maritime/v1/handler';
import { militaryHandler } from '../server/worldmonitor/military/v1/handler';
import { naturalHandler } from '../server/worldmonitor/natural/v1/handler';
import { positiveEventsHandler } from '../server/worldmonitor/positive-events/v1/handler';
import { predictionHandler } from '../server/worldmonitor/prediction/v1/handler';
import { radiationHandler } from '../server/worldmonitor/radiation/v1/handler';
import { researchHandler } from '../server/worldmonitor/research/v1/handler';
import { resilienceHandler } from '../server/worldmonitor/resilience/v1/handler';
import { safetyHandler } from '../server/worldmonitor/safety/v1/handler';
import { sanctionsHandler } from '../server/worldmonitor/sanctions/v1/handler';
import { scorecardHandler } from '../server/worldmonitor/scorecard/v1/handler';
import { seismologyHandler } from '../server/worldmonitor/seismology/v1/handler';
import { supplyChainHandler } from '../server/worldmonitor/supply-chain/v1/handler';
import { thermalHandler } from '../server/worldmonitor/thermal/v1/handler';
import { tradeHandler } from '../server/worldmonitor/trade/v1/handler';
import { unrestHandler } from '../server/worldmonitor/unrest/v1/handler';
import { webcamHandler } from '../server/worldmonitor/webcam/v1/handler';
import { wildfireHandler } from '../server/worldmonitor/wildfire/v1/handler';

const gateway = createDomainGateway([
  ...createAviationServiceRoutes(aviationHandler, serverOptions),
  ...createClimateServiceRoutes(climateHandler, serverOptions),
  ...createConflictServiceRoutes(conflictHandler, serverOptions),
  ...createConsumerPricesServiceRoutes(consumerPricesHandler, serverOptions),
  ...createCyberServiceRoutes(cyberHandler, serverOptions),
  ...createEconomicServiceRoutes(economicHandler, serverOptions),
  ...createForecastServiceRoutes(forecastHandler, serverOptions),
  ...createGivingServiceRoutes(givingHandler, serverOptions),
  ...createHealthServiceRoutes(healthHandler, serverOptions),
  ...createImageryServiceRoutes(imageryHandler, serverOptions),
  ...createInfrastructureServiceRoutes(infrastructureHandler, serverOptions),
  ...createMaritimeServiceRoutes(maritimeHandler, serverOptions),
  ...createMilitaryServiceRoutes(militaryHandler, serverOptions),
  ...createNaturalServiceRoutes(naturalHandler, serverOptions),
  ...createPositiveEventsServiceRoutes(positiveEventsHandler, serverOptions),
  ...createPredictionServiceRoutes(predictionHandler, serverOptions),
  ...createRadiationServiceRoutes(radiationHandler, serverOptions),
  ...createResearchServiceRoutes(researchHandler, serverOptions),
  ...createResilienceServiceRoutes(resilienceHandler, serverOptions),
  ...createSafetyServiceRoutes(safetyHandler, serverOptions),
  ...createSanctionsServiceRoutes(sanctionsHandler, serverOptions),
  ...createScorecardServiceRoutes(scorecardHandler, serverOptions),
  ...createSeismologyServiceRoutes(seismologyHandler, serverOptions),
  ...createSupplyChainServiceRoutes(supplyChainHandler, serverOptions),
  ...createThermalServiceRoutes(thermalHandler, serverOptions),
  ...createTradeServiceRoutes(tradeHandler, serverOptions),
  ...createUnrestServiceRoutes(unrestHandler, serverOptions),
  ...createWebcamServiceRoutes(webcamHandler, serverOptions),
  ...createWildfireServiceRoutes(wildfireHandler, serverOptions),
]);

export default function handler(request: Request, context?: Parameters<typeof gateway>[1]): Promise<Response> {
  return gateway(restoreDomainRequest(request), context);
}
