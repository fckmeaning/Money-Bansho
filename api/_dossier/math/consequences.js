// Economic consequences of one event, assembled deterministically from what the code has already measured
// (event study, analogue corridor, significance, corroboration, observed market moves) plus a fixed table of
// transmission channels that are TYPICAL for the kind of event. Nothing is generated or estimated here.
// Rules and wording: docs/math/consequences.md. Pure functions, no network.
import companies from '../companies.js';
import { classifyTexts } from '../world.js';

/** False discovery rate level of the event-study correction (math/report.js). */
export const Q_LEVEL = 0.1;
const MAX_EXPOSED = 10;
const MAIN_HORIZON = 5;

const pick = (lang, ru, en) => (lang === 'en' ? en : ru);

function num(value, lang, digits = 1) {
  const text = Math.abs(value).toFixed(digits);
  const sign = value < 0 && Number(text) !== 0 ? '−' : '';
  return sign + (lang === 'en' ? text : text.replace('.', ','));
}
const signed = (value, lang, digits = 1) => `${value > 0 && Number(value.toFixed(digits)) !== 0 ? '+' : ''}${num(value, lang, digits)}`;
const finite = (value) => Number.isFinite(value);

// ---- typical channels ----------------------------------------------------------------

const LINE_LABELS = {
  revenue: ['Выручка и спрос', 'Revenue and demand'],
  cost: ['Издержки', 'Costs'],
  risk: ['Риски', 'Risks'],
  valuation: ['Оценка и финансирование', 'Valuation and funding'],
};

const c = (line, ru, en) => ({ line, ru, en });

/** channels: lines an event of this kind can reach; watch: what would confirm or refute it. Judgement, not measurement. */
const COMPANY_TYPES = {
  leadership: {
    name: ['Смена руководства', 'Leadership change'],
    horizon: ['от первых сессий до нескольких кварталов (смена курса видна в отчётности позже)', 'from the first sessions to several quarters (a change of course shows up in later reports)'],
    channels: [
      c('revenue', 'пересмотр стратегии: набор продуктов, рынков и крупных контрактов', 'strategy review: product mix, markets and large contracts'),
      c('cost', 'реструктуризация, выходные пособия, расходы на переходный период', 'restructuring, severance and transition costs'),
      c('risk', 'преемственность управления, уход ключевых сотрудников', 'succession and continuity, departure of key staff'),
      c('valuation', 'премия за неопределённость в стоимости капитала, политика дивидендов и выкупа', 'uncertainty premium in the cost of capital, dividend and buyback policy'),
    ],
    watch: [
      ['официальное сообщение или форма 8-K о назначении и сроках', 'an official statement or 8-K on the appointment and timing'],
      ['объявления нового руководства о стратегии, прогнозе и кадрах', 'announcements by new management on strategy, guidance and staff'],
    ],
  },
  scandal: {
    name: ['Скандал или происшествие', 'Scandal or incident'],
    horizon: ['первые сессии; юридические последствия растягиваются на кварталы и годы', 'the first sessions; legal consequences stretch over quarters and years'],
    channels: [
      c('revenue', 'отток клиентов, приостановка контрактов, репутационные потери', 'customer loss, suspended contracts, reputational damage'),
      c('cost', 'юридические расходы, штрафы, компенсации, исправление нарушений', 'legal costs, fines, compensation, remediation'),
      c('risk', 'расследования и иски, смена руководства', 'investigations and lawsuits, management changes'),
      c('valuation', 'резервы под обязательства, повышенная премия за риск', 'provisions for liabilities, higher risk premium'),
    ],
    watch: [
      ['комментарий компании и открытие официального расследования', 'a company response and the opening of an official inquiry'],
      ['резервы, суммы претензий и раскрытия в отчётности', 'provisions, claim amounts and disclosures in filings'],
    ],
  },
  regulation: {
    name: ['Регулирование и суды', 'Regulation and courts'],
    horizon: ['недели и кварталы: решения проходят несколько стадий', 'weeks to quarters: decisions pass through several stages'],
    channels: [
      c('revenue', 'доступ к рынкам, лицензии, ограничения на продажи и цены', 'market access, licences, limits on sales and prices'),
      c('cost', 'расходы на соответствие требованиям, штрафы', 'compliance costs, fines'),
      c('risk', 'апелляции и новые дела, ограничения на сделки', 'appeals and further cases, limits on transactions'),
      c('valuation', 'изменение ожидаемых денежных потоков и премии за регуляторный риск', 'change in expected cash flows and in the regulatory risk premium'),
    ],
    watch: [
      ['текст решения регулятора или суда, сроки вступления в силу и обжалования', 'the text of the ruling, effective dates and appeal deadlines'],
      ['оценка эффекта самой компанией в отчётности', 'the company’s own estimate of the effect in its filings'],
    ],
  },
  earnings: {
    name: ['Отчётность и прогнозы', 'Earnings and guidance'],
    horizon: ['реакция обычно в первые 1–5 сессий; пересмотр ожиданий идёт до следующего отчёта', 'the reaction usually falls in the first 1–5 sessions; expectations are revised until the next report'],
    channels: [
      c('revenue', 'фактическая выручка и прогноз спроса', 'reported revenue and demand outlook'),
      c('cost', 'маржа, себестоимость, операционные расходы', 'margins, cost of sales, operating expenses'),
      c('risk', 'расхождение с ожиданиями, качество прибыли, долговая нагрузка', 'surprise against expectations, earnings quality, leverage'),
      c('valuation', 'пересмотр прогнозов прибыли и мультипликаторов, дивиденды и выкуп', 'revision of profit forecasts and multiples, dividends and buybacks'),
    ],
    watch: [
      ['первичный отчёт и прогноз компании, а не пересказ в новостях', 'the primary report and guidance rather than news summaries'],
      ['отчёты компаний того же сектора: общий это спрос или особенность компании', 'peer reports: sector-wide demand or company-specific'],
    ],
  },
  deal: {
    name: ['Сделка или партнёрство', 'Deal or partnership'],
    horizon: ['объявление отражается в первые сессии, исполнение занимает кварталы', 'the announcement is absorbed in the first sessions, execution takes quarters'],
    channels: [
      c('revenue', 'новые рынки, объёмы контракта, синергии по продажам', 'new markets, contract volume, sales synergies'),
      c('cost', 'расходы на интеграцию, цена сделки, обслуживание долга', 'integration costs, deal price, debt service'),
      c('risk', 'одобрения регуляторов, срыв или изменение условий', 'regulatory approvals, collapse or renegotiation'),
      c('valuation', 'размытие долей, долговая нагрузка, пересмотр мультипликаторов', 'dilution, leverage, revision of multiples'),
    ],
    watch: [
      ['подтверждение обеими сторонами, сумма и способ оплаты', 'confirmation by both sides, price and form of payment'],
      ['одобрения регуляторов и дата закрытия сделки', 'regulatory approvals and closing date'],
    ],
  },
  politics: {
    name: ['Политика и торговые ограничения', 'Politics and trade policy'],
    horizon: ['от нескольких сессий до кварталов, пока меры не уточнены', 'from a few sessions to quarters while the measures are being specified'],
    channels: [
      c('revenue', 'доступ к странам и заказчикам, госзакупки, экспортные ограничения', 'access to countries and customers, public procurement, export controls'),
      c('cost', 'пошлины, перестройка цепочек поставок', 'tariffs, supply chain rearrangement'),
      c('risk', 'санкции, ответные меры, смена позиции властей', 'sanctions, retaliation, policy reversal'),
      c('valuation', 'страновая премия за риск, валютный эффект', 'country risk premium, currency effect'),
    ],
    watch: [
      ['официальный документ, даты вступления в силу и список исключений', 'the official document, effective dates and exemptions'],
      ['ответные меры других стран и оценка компании', 'responses of other countries and the company’s estimate'],
    ],
  },
  product: {
    name: ['Продукт', 'Product'],
    horizon: ['продажи видны в отчётности через один–несколько кварталов', 'sales appear in reports one or a few quarters later'],
    channels: [
      c('revenue', 'спрос на новый или обновлённый продукт, цены, доля рынка', 'demand for a new or updated product, pricing, market share'),
      c('cost', 'разработка, производство, продвижение, возможный отзыв', 'development, production, marketing, possible recall'),
      c('risk', 'задержки, дефекты, ответ конкурентов', 'delays, defects, competitor response'),
      c('valuation', 'ожидания роста, заложенные в мультипликаторы', 'growth expectations embedded in multiples'),
    ],
    watch: [
      ['сроки поставок, цены и первые данные о продажах', 'delivery dates, pricing and first sales data'],
      ['жалобы, отзывы и реакция конкурентов', 'complaints, recalls and competitor response'],
    ],
  },
  other: {
    name: ['Прочее сообщение', 'Other news'],
    horizon: ['не задан для этого вида сообщений', 'not set for this kind of item'],
    channels: [
      c('revenue', 'прямой канал по заголовку не определяется', 'no direct channel can be read from the headline'),
      c('risk', 'репутация и внимание к компании', 'reputation and attention to the company'),
    ],
    watch: [
      ['появится ли подтверждённое событие: отчёт, сделка, решение властей', 'whether a confirmed event follows: a report, a deal, an official decision'],
    ],
  },
};

const WORLD_TYPES = {
  conflict: {
    name: ['Конфликты и безопасность', 'Conflict and security'],
    horizon: ['первые сессии; при эскалации — недели и месяцы', 'the first sessions; weeks to months if it escalates'],
    channels: [
      c('revenue', 'спрос на оборонную продукцию; перебои торговли и туризма в регионе', 'demand for defence goods; disrupted trade and travel in the region'),
      c('cost', 'энергоносители, фрахт и страхование перевозок', 'energy, freight and shipping insurance'),
      c('risk', 'эскалация, санкции, перебои поставок', 'escalation, sanctions, supply disruption'),
      c('valuation', 'уход от риска: защитные активы, премия за риск в акциях и валютах региона', 'risk aversion: safe havens, risk premium in regional equities and currencies'),
    ],
    watch: [
      ['расширение или прекращение боевых действий, переговоры', 'escalation or ceasefire, negotiations'],
      ['маршруты поставок, нефть, золото и VIX в следующие сессии', 'supply routes, oil, gold and VIX in the following sessions'],
    ],
  },
  sanctions: {
    name: ['Санкции и торговля', 'Sanctions and trade'],
    horizon: ['объявление — дни; влияние на торговлю — кварталы', 'days for the announcement; quarters for trade effects'],
    channels: [
      c('revenue', 'экспорт и доступ к рынкам затронутых стран и компаний', 'exports and market access of affected countries and firms'),
      c('cost', 'пошлины, замена поставщиков, логистика', 'tariffs, supplier replacement, logistics'),
      c('risk', 'ответные меры, вторичные санкции', 'retaliation, secondary sanctions'),
      c('valuation', 'курсы валют и страновая премия за риск', 'exchange rates and country risk premium'),
    ],
    watch: [
      ['официальный список мер, даты и исключения', 'the official list of measures, dates and exemptions'],
      ['ответные меры и курсы затронутых валют', 'retaliation and the affected currencies'],
    ],
  },
  central_bank: {
    name: ['Центробанки и ставки', 'Central banks and rates'],
    horizon: ['рынки — часы и сессии; экономика — несколько кварталов', 'hours and sessions for markets; several quarters for the economy'],
    channels: [
      c('revenue', 'кредитный спрос, потребление и инвестиции', 'credit demand, consumption and investment'),
      c('cost', 'стоимость заимствований для компаний и государства', 'borrowing costs for firms and government'),
      c('risk', 'инфляция, расхождение решения с ожиданиями', 'inflation, surprise against expectations'),
      c('valuation', 'ставка дисконтирования: доходности облигаций, мультипликаторы акций, курс валюты', 'discount rate: bond yields, equity multiples, exchange rate'),
    ],
    watch: [
      ['решение и комментарий регулятора, следующие данные по инфляции и занятости', 'the decision and guidance, the next inflation and labour data'],
      ['доходности облигаций и курс валюты после решения', 'bond yields and the currency after the decision'],
    ],
  },
  energy: {
    name: ['Энергетика', 'Energy'],
    horizon: ['котировки — дни; издержки и инфляция — месяцы', 'days for prices; months for costs and inflation'],
    channels: [
      c('revenue', 'доходы производителей нефти и газа, экспортёров', 'income of oil and gas producers and exporters'),
      c('cost', 'топливо и электроэнергия: транспорт, химия, промышленность', 'fuel and power: transport, chemicals, industry'),
      c('risk', 'перебои поставок, решения ОПЕК+, санкции', 'supply disruption, OPEC+ decisions, sanctions'),
      c('valuation', 'инфляционные ожидания и траектория ставок', 'inflation expectations and the rate path'),
    ],
    watch: [
      ['фактические объёмы поставок и запасы', 'actual supply volumes and inventories'],
      ['цены нефти и газа в следующие сессии', 'oil and gas prices in the following sessions'],
    ],
  },
  disaster: {
    name: ['Катастрофы и здоровье', 'Disasters and health'],
    horizon: ['дни и недели; восстановление — кварталы', 'days to weeks; recovery takes quarters'],
    channels: [
      c('revenue', 'остановка производства и спроса в пострадавшем районе', 'lost output and demand in the affected area'),
      c('cost', 'восстановление, страховые выплаты, логистика', 'reconstruction, insurance payouts, logistics'),
      c('risk', 'перебои в цепочках поставок', 'supply chain disruption'),
      c('valuation', 'страховщики и бюджет пострадавшей страны', 'insurers and the affected country’s budget'),
    ],
    watch: [
      ['масштаб ущерба по официальным данным', 'official damage estimates'],
      ['остановки предприятий, портов и перевозок', 'closures of plants, ports and transport'],
    ],
  },
  elections: {
    name: ['Выборы и власть', 'Elections and government'],
    horizon: ['до подсчёта и формирования правительства — дни и недели; меры — кварталы', 'days to weeks until results and a government; quarters for policy'],
    channels: [
      c('revenue', 'госрасходы и приоритетные отрасли', 'public spending and favoured sectors'),
      c('cost', 'налоги, регулирование, торговая политика', 'taxes, regulation, trade policy'),
      c('risk', 'политическая неопределённость, коалиционные кризисы', 'political uncertainty, coalition crises'),
      c('valuation', 'страновая премия за риск, курс валюты, доходности госдолга', 'country risk premium, currency, government bond yields'),
    ],
    watch: [
      ['официальные результаты и состав коалиции или кабинета', 'official results and the coalition or cabinet'],
      ['бюджетные и торговые заявления новой власти', 'budget and trade statements of the new government'],
    ],
  },
  economy: {
    name: ['Экономика и рынки', 'Economy and markets'],
    horizon: ['рынки — сессии; экономика — кварталы', 'sessions for markets; quarters for the economy'],
    channels: [
      c('revenue', 'совокупный спрос, прибыли компаний', 'aggregate demand, corporate profits'),
      c('cost', 'зарплаты, сырьё, стоимость кредита', 'wages, inputs, cost of credit'),
      c('risk', 'долговые проблемы, увольнения, спад', 'debt stress, layoffs, downturn'),
      c('valuation', 'ожидания по ставкам и премия за риск', 'rate expectations and risk premium'),
    ],
    watch: [
      ['следующие официальные данные по этой теме', 'the next official data on the subject'],
      ['реакция индексов, доходностей и VIX', 'indices, yields and VIX'],
    ],
  },
  other: {
    name: ['Прочее', 'Other'],
    horizon: ['не задан для этого вида сообщений', 'not set for this kind of item'],
    channels: [c('risk', 'устойчивый экономический канал по заголовку не определяется', 'no stable economic channel can be read from the headline')],
    watch: [['появятся ли официальные меры или данные с экономическим содержанием', 'whether official measures or data with economic content follow']],
  },
};

// ---- instruments typical for a region ------------------------------------------------

const inst = (kind, symbol, ru, en = ru) => ({ kind, symbol, ru, en });
const REGION_INSTRUMENTS = {
  us: [inst('index', '^GSPC', 'S&P 500'), inst('fx', 'DX-Y.NYB', 'Индекс доллара', 'US dollar index')],
  europe: [inst('index', '^STOXX50E', 'Euro Stoxx 50'), inst('fx', 'EURUSD=X', 'EUR/USD')],
  china: [inst('index', '^HSI', 'Hang Seng'), inst('fx', 'CNY=X', 'USD/CNY')],
  israel: [inst('index', '^TA125.TA', 'TA-125'), inst('fx', 'ILS=X', 'USD/ILS')],
  korea: [inst('index', '^KS11', 'KOSPI'), inst('fx', 'KRW=X', 'USD/KRW')],
  russia: [inst('fx', 'RUB=X', 'USD/RUB'), inst('commodity', 'BZ=F', 'Нефть Brent', 'Brent crude')],
  asia: [inst('index', '^N225', 'Nikkei 225')],
};
const TYPE_INSTRUMENTS = {
  conflict: [inst('commodity', 'BZ=F', 'Нефть Brent', 'Brent crude'), inst('commodity', 'GC=F', 'Золото', 'Gold'), inst('index', '^VIX', 'VIX')],
  sanctions: [inst('fx', 'DX-Y.NYB', 'Индекс доллара', 'US dollar index'), inst('commodity', 'GC=F', 'Золото', 'Gold')],
  central_bank: [inst('yield', '^TNX', 'Доходность UST 10 лет', 'US 10-year yield'), inst('fx', 'DX-Y.NYB', 'Индекс доллара', 'US dollar index')],
  energy: [inst('commodity', 'BZ=F', 'Нефть Brent', 'Brent crude'), inst('commodity', 'NG=F', 'Газ (Henry Hub)', 'Natural gas (Henry Hub)')],
  disaster: [inst('index', '^VIX', 'VIX')],
  economy: [inst('index', '^VIX', 'VIX'), inst('yield', '^TNX', 'Доходность UST 10 лет', 'US 10-year yield')],
};

const COUNTRY_CURRENCY = {
  CN: ['CNY=X', 'USD/CNY'], DE: ['EURUSD=X', 'EUR/USD'], FR: ['EURUSD=X', 'EUR/USD'], NL: ['EURUSD=X', 'EUR/USD'],
  BE: ['EURUSD=X', 'EUR/USD'], IT: ['EURUSD=X', 'EUR/USD'], ES: ['EURUSD=X', 'EUR/USD'], FI: ['EURUSD=X', 'EUR/USD'],
  GB: ['GBPUSD=X', 'GBP/USD'], CH: ['CHF=X', 'USD/CHF'], DK: ['DKK=X', 'USD/DKK'], SE: ['SEK=X', 'USD/SEK'],
  NO: ['NOK=X', 'USD/NOK'], IL: ['ILS=X', 'USD/ILS'], KR: ['KRW=X', 'USD/KRW'], JP: ['JPY=X', 'USD/JPY'],
  TW: ['TWD=X', 'USD/TWD'], CA: ['CAD=X', 'USD/CAD'], AU: ['AUDUSD=X', 'AUD/USD'], IN: ['INR=X', 'USD/INR'],
};

const BENCHMARK_NAMES = {
  '^GSPC': 'S&P 500', '^HSI': 'Hang Seng', '000001.SS': 'Shanghai Composite', '399001.SZ': 'Shenzhen Component',
  '^TA125.TA': 'TA-125', '^KS11': 'KOSPI', '^KQ11': 'KOSDAQ', '^GDAXI': 'DAX', '^FCHI': 'CAC 40', '^STOXX': 'STOXX Europe 600',
  '^STOXX50E': 'Euro Stoxx 50', '^SSMI': 'SMI', '^FTSE': 'FTSE 100', '^N225': 'Nikkei 225', '^TWII': 'TAIEX',
};

const channelsOf = (profile, lang) => profile.channels.map((x) => ({
  line: x.line, label: pick(lang, ...LINE_LABELS[x.line]), text: pick(lang, x.ru, x.en),
}));

function unique(list) {
  const seen = new Set();
  return list.filter((x) => {
    const key = x.symbol ?? x.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_EXPOSED);
}

// ---- shared parts --------------------------------------------------------------------

const CONFIDENCE = {
  high: ['высокая', 'high'], medium: ['средняя', 'medium'], low: ['низкая', 'low'],
};

function confidenceOf(points, reasons, lang, cap = 'high') {
  const order = ['low', 'medium', 'high'];
  const raw = points >= 3 ? 2 : points === 2 ? 1 : 0;
  const level = order[Math.min(raw, order.indexOf(cap))];
  return { level, label: pick(lang, ...CONFIDENCE[level]), reasons };
}

const caveat = (lang) => pick(lang,
  'Не причинный вывод и не инвестиционная рекомендация: изменения цен совпадают с событием по времени, каналы — типичные для такого вида событий.',
  'Not a causal finding and not investment advice: price changes coincide with the event in time; channels are typical for this kind of event.');

function directionText(lang, code, main) {
  if (code === 'insufficient') {
    return pick(lang, 'Ожидаемое направление: нет данных (коридор не рассчитан).', 'Expected direction: no data (no corridor computed).');
  }
  return pick(lang,
    `Направление не прогнозируется: коридор на ${main.h} сессий центрирован на нуле. На проверке средний исход похожих сообщений не предсказывал знак.`,
    `Direction is not forecast: the ${main.h}-session corridor is centred on zero. In testing, the average outcome of similar items did not predict the sign.`);
}

// ---- company events ------------------------------------------------------------------

function observedCompany(event, changePct, lang) {
  const impact = event.impact;
  const lines = [];
  let short = pick(lang, 'реакция цены — нет данных', 'price reaction: no data');
  let robust = false;
  if (impact && finite(impact.carPct)) {
    const z = finite(impact.z) ? impact.z : null;
    robust = z !== null && Math.abs(z) >= 1.96 && finite(impact.q) && impact.q <= Q_LEVEL;
    const verdict = z === null
      ? pick(lang, 'значимость: нет данных', 'significance: no data')
      : robust
        ? pick(lang, 'отличима от обычных колебаний после поправки на множественные проверки', 'distinct from ordinary swings after the multiple-testing correction')
        : Math.abs(z) >= 1.96
          ? finite(impact.q)
            ? pick(lang, 'велика сама по себе, но после поправки на множественные проверки не отличима от случайной', 'large on its own, but not distinct from chance after the multiple-testing correction')
            : pick(lang, 'велика сама по себе; поправка на множественные проверки не рассчитана', 'large on its own; no multiple-testing correction computed')
          : Math.abs(z) >= 1
            ? pick(lang, 'заметная, но статистически неубедительная', 'noticeable but statistically inconclusive')
            : pick(lang, 'в пределах обычных колебаний', 'within ordinary swings');
    const stats = [
      z === null ? null : `z ${signed(z, lang)}`,
      finite(impact.p) ? `p ${num(impact.p, lang, 3)}` : null,
      finite(impact.q) ? `q ${num(impact.q, lang, 3)}` : null,
      finite(impact.sessions) ? pick(lang, `сессий ${impact.sessions}`, `sessions ${impact.sessions}`) : null,
    ].filter(Boolean).join(', ');
    // Until day +1 closes the window holds day 0 alone.
    const days = impact.sessions === 1 ? pick(lang, 'день 0', 'day 0') : pick(lang, 'дни 0…+1', 'days 0…+1');
    lines.push(pick(lang,
      `Аномальная доходность в окне события (${days}) CAR ${signed(impact.carPct, lang)}% (${stats}): ${verdict}.`,
      `Abnormal return in the event window (${days}) CAR ${signed(impact.carPct, lang)}% (${stats}): ${verdict}.`));
    if (impact.model === 'naive') {
      lines.push(pick(lang, 'Модель рынка не оценена (мало данных): сравнение прямо с бенчмарком.', 'No market model fitted (too little data): compared straight with the benchmark.'));
    }
    lines.push(finite(impact.volumeRatio)
      ? pick(lang, `Объём торгов в день 0: ×${num(impact.volumeRatio, lang, 2)} к медиане 20 сессий.`, `Day-0 volume: ×${num(impact.volumeRatio, lang, 2)} of the 20-session median.`)
      : pick(lang, 'Объём торгов: нет данных.', 'Trading volume: no data.'));
    if (finite(impact.preCarPct) && finite(impact.preZ) && Math.abs(impact.preZ) >= 1.96) {
      lines.push(pick(lang,
        `Заметное движение было и до публикации (CAR ${signed(impact.preCarPct, lang)}% за предыдущие сессии): связь с этим сообщением под вопросом.`,
        `A notable move preceded publication (CAR ${signed(impact.preCarPct, lang)}% in earlier sessions): the link to this item is doubtful.`));
    }
    short = pick(lang,
      `в окне события CAR ${signed(impact.carPct, lang)}%${z === null ? '' : ` (z ${signed(z, lang)}${robust ? ', отличимо от шума' : ', не отличимо уверенно от шума'})`}`,
      `event-window CAR ${signed(impact.carPct, lang)}%${z === null ? '' : ` (z ${signed(z, lang)}${robust ? ', distinct from noise' : ', not clearly distinct from noise'})`}`);
  } else {
    lines.push(pick(lang,
      'Событийный анализ реакции цены: нет данных (первая сессия после публикации не закрыта, не хватает котировок или расчёт для этого списка не выполняется).',
      'Event study of the price reaction: no data (the first session after publication has not closed, quotes are missing, or it is not computed for this list).'));
  }
  if (finite(changePct)) {
    if (!impact || !finite(impact.carPct)) {
      short += pick(lang,
        `, акция за день ${signed(changePct, lang, 2)}% (связь не установлена)`,
        `, stock today ${signed(changePct, lang, 2)}% (no link established)`);
    }
    lines.push(pick(lang,
      `Изменение акции за текущий день: ${signed(changePct, lang, 2)}% (не очищено от движения рынка и может быть не связано с этим сообщением).`,
      `Stock change today: ${signed(changePct, lang, 2)}% (not adjusted for the market and possibly unrelated to this item).`));
  }
  return { lines, short, robust, direction: impact && finite(impact.carPct) ? Math.sign(impact.carPct) : null };
}

function exposedCompany(event, ctx, lang) {
  const company = companies.find((x) => x.symbol === ctx.symbol);
  const country = ctx.country || company?.country || '';
  const benchmark = company?.benchmark ?? ctx.benchmark ?? null;
  const out = [];
  if (ctx.symbol) {
    out.push({ kind: 'company', symbol: ctx.symbol, name: ctx.name ?? company?.name ?? ctx.symbol, note: pick(lang, 'сама компания', 'the company itself') });
  }
  for (const peer of ctx.peers ?? []) {
    out.push({
      kind: 'peer',
      symbol: peer.symbol,
      name: peer.name,
      note: pick(lang,
        `измеренная совместная динамика дневных доходностей: β ${num(peer.beta, lang, 2)}, корреляция ${num(peer.corr, lang, 2)}, наблюдений ${peer.pairs}`,
        `measured co-movement of daily returns: β ${num(peer.beta, lang, 2)}, correlation ${num(peer.corr, lang, 2)}, ${peer.pairs} observations`),
    });
  }
  if (!(ctx.peers ?? []).length && country) {
    for (const peer of companies.filter((x) => x.country === country && x.symbol !== ctx.symbol).slice(0, 3)) {
      out.push({ kind: 'peer', symbol: peer.symbol, name: peer.name, note: pick(lang, 'компания того же рынка; связь не измерена', 'same home market; link not measured') });
    }
  }
  if (benchmark) {
    out.push({ kind: 'index', symbol: benchmark, name: BENCHMARK_NAMES[benchmark] ?? benchmark, note: pick(lang, 'бенчмарк, относительно которого считается реакция', 'benchmark the reaction is measured against') });
  }
  const currency = COUNTRY_CURRENCY[country];
  if (currency) {
    out.push({ kind: 'fx', symbol: currency[0], name: currency[1], note: pick(lang, 'валюта домашнего рынка: типичный канал', 'home-market currency: typical channel') });
  }
  return unique(out);
}

function corroboration(event, lang) {
  const filing = event.source === 'SEC EDGAR';
  const outlets = Number.isFinite(event.outlets) && event.outlets > 1 ? event.outlets : 1;
  const text = filing
    ? pick(lang, 'официальный документ SEC EDGAR', 'official SEC EDGAR filing')
    : outlets > 1
      ? pick(lang, `изданий с этим сюжетом: ${outlets}`, `outlets carrying the story: ${outlets}`)
      : pick(lang, 'найден один источник', 'a single source found');
  return { ok: filing || outlets >= 3, text };
}

/**
 * One company event. `ctx`: {symbol, name, country, benchmark, changePct, peers, forecasts}.
 * `event.outlook` (1/5/20-session corridor of math/forecast.js) is optional.
 */
export function companyConsequences(event, ctx = {}, lang = 'ru') {
  const profile = COMPANY_TYPES[event.type] ?? COMPANY_TYPES.other;
  const observed = observedCompany(event, ctx.changePct, lang);
  const horizons = (event.outlook ?? []).map((h) => ({
    h: h.h,
    low80Pct: h.low80Pct,
    high80Pct: h.high80Pct,
    // Width factor measured for this type of item; 1 = the ordinary corridor.
    multiplier: h.multiplier,
    fresh: h.fresh,
    n: h.n,
  }));
  const main = horizons.find((h) => h.h === MAIN_HORIZON);
  // The corridor is centred on zero: tests did not show that such items predict the sign.
  const code = main ? 'uncertain' : 'insufficient';
  const widened = Boolean(main && main.multiplier > 1);

  let magnitude;
  if (main) {
    const range = pick(lang,
      `На ${main.h} сессий от последнего закрытия 80% исходов: от ${signed(main.low80Pct, lang)}% до ${signed(main.high80Pct, lang)}%.`,
      `${main.h} sessions from the last close, 80% of outcomes: ${signed(main.low80Pct, lang)}% to ${signed(main.high80Pct, lang)}%.`);
    let basis;
    if (widened) {
      basis = pick(lang,
        ` Коридор расширен в ${num(main.multiplier, lang, 2)} раза: настолько шире были исходы после сообщений такого типа в проверенной истории.`,
        ` The corridor is widened ${num(main.multiplier, lang, 2)} times: that is how much wider outcomes were after this type of item in the tested history.`);
    } else if (main.fresh) {
      basis = pick(lang, ' Это обычная волатильность акции: поправки на такой тип сообщения не найдено.', ' This is the ordinary volatility of the stock: no adjustment was found for this type of item.');
    } else {
      basis = pick(lang, ' Это обычная волатильность акции: после сообщения уже были торги, реакция учтена в цене.', ' This is the ordinary volatility of the stock: sessions have closed since the item, the reaction is in the price.');
    }
    magnitude = range + basis;
  } else {
    magnitude = event.type === 'other'
      ? pick(lang, 'Коридор: нет данных (для прочих сообщений не рассчитывается).', 'Corridor: no data (not computed for unclassified items).')
      : pick(lang, 'Коридор: нет данных (рассчитывается в досье компании при достаточной истории цен).', 'Corridor: no data (computed in the company dossier when price history is sufficient).');
  }

  const source = corroboration(event, lang);
  const sig = event.significance;
  const significance = sig && finite(sig.score)
    ? pick(lang,
      `Значимость ${sig.score}/100 (интервал 80%: ${sig.low}–${sig.high}): оценка вероятности заметной реакции цены, не её направления.`,
      `Significance ${sig.score}/100 (80% interval ${sig.low}–${sig.high}): estimated chance of a notable price reaction, not its direction.`)
    : pick(lang, 'Балл значимости: нет данных.', 'Significance score: no data.');

  const analogueOk = Boolean(main && main.n >= 8);
  const points = Number(source.ok) + Number(observed.robust) + Number(analogueOk);
  const reasons = [
    source.text,
    observed.robust
      ? pick(lang, 'реакция цены отличима от шума', 'price reaction distinct from noise')
      : observed.direction === null
        ? pick(lang, 'реакция цены не измерена', 'price reaction not measured')
        : pick(lang, 'реакция цены не отличима уверенно от шума', 'price reaction not clearly distinct from noise'),
    analogueOk
      ? pick(lang, `похожих прошлых сообщений: ${main.n}`, `similar earlier items: ${main.n}`)
      : pick(lang, 'похожих прошлых сообщений нет или мало', 'no or few similar earlier items'),
  ];
  const confidence = confidenceOf(points, reasons, lang);

  const watch = profile.watch.map(([ru, en]) => pick(lang, ru, en));
  if (!source.ok) watch.push(pick(lang, 'подтверждение независимыми источниками или официальным документом', 'confirmation by independent sources or an official document'));
  watch.push(observed.direction === null
    ? pick(lang, 'закрытие первых двух сессий после публикации: выйдет ли отклонение от рынка за обычные колебания', 'the first two closes after publication: whether the move against the market exceeds ordinary swings')
    : pick(lang, 'сохранится ли отклонение от рынка в следующие 5 сессий или вернётся назад', 'whether the move against the market persists over the next 5 sessions or reverses'));

  const factor = widened ? `, ×${num(main.multiplier, lang, 2)}` : '';
  const outlookShort = main
    ? pick(lang,
      `коридор на ${main.h} сессий от ${signed(main.low80Pct, lang)}% до ${signed(main.high80Pct, lang)}% (80%${factor}), направление не определено`,
      `${main.h}-session corridor ${signed(main.low80Pct, lang)}% to ${signed(main.high80Pct, lang)}% (80%${factor}), direction undetermined`)
    : pick(lang, 'коридор — нет данных', 'corridor: no data');
  // With nothing measured the one-liner leads with the channels, so that it still says something about consequences.
  const lineNames = [...new Set(channelsOf(profile, lang).map((x) => x.label.toLowerCase()))].join(', ');
  const lead = observed.direction === null && !main
    ? `${pick(lang, 'типичные каналы', 'typical channels')} — ${lineNames}; `
    : '';
  const summary = `${pick(lang, ...profile.name)}: ${lead}${observed.short}; ${outlookShort}; ${pick(lang, 'надёжность оценки', 'confidence')} ${confidence.label}.`;

  return {
    basis: 'company',
    summary,
    direction: { code, text: directionText(lang, code, main) },
    observed: observed.lines,
    magnitude: { text: magnitude, horizons },
    horizon: pick(lang, `Типичный горизонт: ${profile.horizon[0]}.`, `Typical horizon: ${profile.horizon[1]}.`),
    evidence: [significance, `${pick(lang, 'Подтверждение', 'Corroboration')}: ${source.text}.`],
    channels: channelsOf(profile, lang),
    exposed: exposedCompany(event, ctx, lang),
    confidence,
    watch,
    caveat: caveat(lang),
  };
}

// ---- world events and economy headlines ------------------------------------------------

function movedText(name, change, unit, z, lang) {
  const suffix = unit === 'bp' ? pick(lang, ' б.п.', ' bp') : '%';
  return `${name} ${signed(change, lang, unit === 'bp' ? 1 : 2)}${suffix}${finite(z) ? ` (z ${signed(z, lang)})` : ''}`;
}

function worldShell({ profile, observed, short, exposed, evidence, confidence, watch, lang, basis }) {
  return {
    basis,
    summary: `${pick(lang, ...profile.name)}: ${short}; ${pick(lang, 'направление последствий не определено', 'direction of consequences undetermined')}; ${pick(lang, 'надёжность оценки', 'confidence')} ${confidence.label}.`,
    direction: {
      code: 'uncertain',
      text: pick(lang,
        'Направление не определено: для событий без компании оценка по аналогам не рассчитывается.',
        'Direction undetermined: no analogue estimate is computed for events without a company.'),
    },
    observed,
    magnitude: {
      text: pick(lang, 'Ожидаемый масштаб и интервал на 1/5/20 сессий: нет данных.', 'Expected size and interval over 1/5/20 sessions: no data.'),
      horizons: [],
    },
    horizon: pick(lang, `Типичный горизонт: ${profile.horizon[0]}.`, `Typical horizon: ${profile.horizon[1]}.`),
    evidence,
    channels: channelsOf(profile, lang),
    exposed: unique(exposed),
    confidence,
    watch: watch ?? profile.watch.map(([ru, en]) => pick(lang, ru, en)),
    caveat: caveat(lang),
  };
}

function typicalInstruments(typeId, regions, lang) {
  const list = [...regions.flatMap((r) => REGION_INSTRUMENTS[r] ?? []), ...(TYPE_INSTRUMENTS[typeId] ?? [])];
  return list.map((x) => ({ kind: x.kind, symbol: x.symbol, name: pick(lang, x.ru, x.en), note: pick(lang, 'типичный канал; связь не измерена', 'typical channel; link not measured') }));
}

/** A clustered world event (api/_dossier/world.js), including the short rows of `more`. */
export function worldConsequences(event, lang = 'ru') {
  const profile = WORLD_TYPES[event.type] ?? WORLD_TYPES.other;
  const regions = (event.regions?.length ? event.regions : [event.primaryRegion]).filter(Boolean).slice(0, 2);
  const measured = (event.assets ?? []).filter((a) => a.observed);
  const observed = (event.assets ?? []).map((a) => (a.observed
    ? pick(lang,
      `${movedText(a.name, a.observed.change, a.observed.unit, a.observed.z, lang)} за ${a.observed.sessions} сесс. с закрытия перед датой события.`,
      `${movedText(a.name, a.observed.change, a.observed.unit, a.observed.z, lang)} over ${a.observed.sessions} session(s) since the close before the event date.`)
    : `${a.name}: ${pick(lang, `нет данных${a.reason && a.reason !== 'нет данных' ? ` (${a.reason})` : ''}`, 'no data')}.`));
  if (observed.length) observed.push(pick(lang, 'Совпадение во времени, не причинность.', 'Coincidence in time, not causation.'));
  else observed.push(pick(lang, 'Измеренные движения рынков: нет данных.', 'Measured market moves: no data.'));
  const largest = [...measured].sort((a, b) => Math.abs(b.observed.z) - Math.abs(a.observed.z))[0];
  const short = largest
    ? pick(lang,
      `наибольшее наблюдаемое движение — ${movedText(largest.name, largest.observed.change, largest.observed.unit, largest.observed.z, lang)}`,
      `largest observed move: ${movedText(largest.name, largest.observed.change, largest.observed.unit, largest.observed.z, lang)}`)
    : pick(lang, 'движения рынков: нет данных', 'market moves: no data');

  const exposed = [
    ...(event.assets ?? []).map((a) => ({
      kind: a.kind ?? 'market',
      symbol: a.symbol,
      name: a.name,
      note: a.observed ? pick(lang, 'движение измерено, связь с событием не доказана', 'move measured, link to the event not established') : pick(lang, 'движение: нет данных', 'move: no data'),
    })),
    ...(event.companies ?? []).map((x) => ({
      kind: 'company',
      symbol: x.symbol,
      name: x.name,
      note: lang === 'en' ? 'matched by headline, country or sector; link not measured' : `отобрана по признаку «${x.basis}»; связь не измерена`,
    })),
    ...typicalInstruments(event.type, regions, lang),
  ];

  const sources = event.sourceCount ?? 1;
  const independent = finite(event.independent) ? event.independent : null;
  const sourceText = pick(lang,
    `источников: ${sources}${independent === null ? '' : `, независимых примерно ${num(independent, lang)}`}`,
    `sources: ${sources}${independent === null ? '' : `, about ${num(independent, lang)} independent`}`);
  const corroborated = (independent ?? sources) >= 2.5;
  // Never above "medium": nothing here tests that the event moved anything.
  const confidence = confidenceOf(corroborated && measured.length ? 2 : 0, [
    sourceText,
    measured.length ? pick(lang, 'движения рынков измерены, причинная связь не проверяется', 'market moves measured, causation not tested') : pick(lang, 'движения рынков не измерены', 'market moves not measured'),
    pick(lang, 'аналоги не рассчитываются', 'no analogue estimate'),
  ], lang, 'medium');

  return worldShell({
    basis: 'world',
    profile,
    observed,
    short,
    exposed,
    evidence: [
      finite(event.score)
        ? pick(lang, `Значимость ${num(event.score, lang)}/100 (прозрачный балл: источники, свежесть, тон, тип, рынок).`, `Significance ${num(event.score, lang)}/100 (transparent score: sources, recency, tone, type, market).`)
        : pick(lang, 'Балл значимости: нет данных.', 'Significance score: no data.'),
      `${pick(lang, 'Подтверждение', 'Corroboration')}: ${sourceText}.`,
    ],
    confidence,
    lang,
  });
}

/** A single headline attached to an instrument of the economy block; `row` carries its measured daily move. */
export function headlineConsequences(item, row, lang = 'ru') {
  const typeId = classifyTexts([item.title ?? '']).id;
  // A headline found for a market instrument but with no clearer subject is read as market news.
  const profile = WORLD_TYPES[typeId === 'other' && row ? 'economy' : typeId] ?? WORLD_TYPES.other;
  const name = row?.name ?? row?.symbol ?? '';
  const has = row && finite(row.change1d);
  const move = has ? movedText(name, row.change1d, row.unit, row.z1d, lang) : null;
  const observed = has
    ? [
      pick(lang, `Дневное изменение инструмента: ${move}.`, `Daily change of the instrument: ${move}.`),
      pick(lang, 'Заголовок найден по названию инструмента; связь с движением не доказана.', 'The headline was found by the instrument name; no link to the move is established.'),
    ]
    : [pick(lang, 'Движение инструмента: нет данных.', 'Instrument move: no data.')];
  const exposed = [
    ...(row ? [{ kind: row.group ?? 'market', symbol: row.symbol, name, note: pick(lang, 'инструмент, по которому найден заголовок', 'instrument the headline was found for') }] : []),
    ...typicalInstruments(typeId === 'other' && row ? 'economy' : typeId, [], lang),
  ];
  const confidence = confidenceOf(0, [
    pick(lang, 'один заголовок', 'a single headline'),
    pick(lang, 'связь с движением не проверяется', 'link to the move not tested'),
    pick(lang, 'аналоги не рассчитываются', 'no analogue estimate'),
  ], lang, 'low');
  return worldShell({
    basis: 'headline',
    profile,
    observed,
    short: has ? pick(lang, `дневное движение: ${move}`, `daily move: ${move}`) : pick(lang, 'движение инструмента: нет данных', 'instrument move: no data'),
    exposed,
    evidence: [
      pick(lang, 'Балл значимости: нет данных.', 'Significance score: no data.'),
      pick(lang, `Подтверждение: один найденный источник (${item.source || 'не указан'}).`, `Corroboration: one source found (${item.source || 'not stated'}).`),
    ],
    confidence,
    lang,
  });
}

// ---- response post-processing (never mutates: bodies may be shared with caches) -------

const safe = (build) => {
  try {
    return build();
  } catch (error) {
    console.error('[consequences]', error);
    return null;
  }
};
const attach = (list, build) => (list ?? []).map((item) => ({ ...item, consequences: safe(() => build(item)) }));

export function explainDossier(dossier, lang = 'ru') {
  return {
    ...dossier,
    events: attach(dossier.events, (event) => {
      const peers = dossier.forecast?.links?.linked ?? [];
      return companyConsequences(event, { symbol: dossier.symbol, name: dossier.name, country: dossier.country, peers }, lang);
    }),
  };
}

export function explainWire(wire, lang = 'ru') {
  return {
    ...wire,
    events: attach(wire.events, (event) => companyConsequences(event, { symbol: event.symbol, name: event.name, changePct: event.changePct }, lang)),
  };
}

export function explainWorld(world, lang = 'ru') {
  return {
    ...world,
    events: attach(world.events, (event) => worldConsequences(event, lang)),
    ...(world.more ? { more: attach(world.more, (event) => worldConsequences(event, lang)) } : {}),
  };
}

export function explainEconomy(economy, lang = 'ru') {
  const rows = new Map((economy.rows ?? []).map((r) => [r.symbol, r]));
  return {
    ...economy,
    news: Object.fromEntries(Object.entries(economy.news ?? {}).map(([symbol, items]) => [
      symbol,
      attach(items, (item) => headlineConsequences(item, rows.get(symbol), lang)),
    ])),
  };
}
