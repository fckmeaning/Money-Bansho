// One page per model. Formulas and thresholds follow docs/bansho-math.md and
// docs/math/*.md, which describe the code in api/_dossier.
import type { L } from './ui';

export interface Model {
  id: string;
  title: L;
  question: L;
  explain: L[];
  formulas: Array<[L, string]>;
  limits: L[];
  code: string[];
  /** Where the number is shown: [href, label]. */
  used: Array<[string, L]>;
  related: string[];
}

const dossier = (view: string, label: L): [string, L] => [`/dossier.html?symbol=NVDA&view=${view}`, label];
const MODEL_TAB = dossier('model', ['Досье: вкладка «Модель» (пример NVDA)', 'Dossier: Model tab (NVDA example)']);
const EVENTS_TAB = dossier('events', ['Досье: вкладка «События»', 'Dossier: Events tab']);
const METRICS_TAB = dossier('metrics', ['Досье: вкладка «Метрики»', 'Dossier: Metrics tab']);
const OVERVIEW: [string, L] = ['/dossier.html', ['Обзор рынка', 'Market overview']];
const FORECAST: [string, L] = ['/forecast.html#/method', ['Прогноз: метод', 'Forecast: method']];
const WORLD: [string, L] = ['/dossier.html?view=world', ['Мир: главные события', 'World events']];
const ATLAS: [string, L] = ['/dossier.html?view=analytics', ['Аналитика и графы', 'Analytics and graphs']];
const DASH: [string, L] = ['/dashboard', ['Карта мира', 'World map']];

export const MODELS: Model[] = [
  {
    id: 'event-study',
    title: ['Событийный анализ', 'Event study'],
    question: ['Было ли движение цены после новости необычным?', 'Was the price move after a headline unusual?'],
    explain: [
      ['Дневные логарифмические доходности акции сравниваются с рыночной моделью по её биржевому индексу. Окно оценки (до 120 сессий, минимум 30) кончается за 5 сессий до события; бета сжимается к единице. При меньше 30 наблюдениях берутся альфа 0 и бета 1.', 'Daily log returns are compared with a market model on the home index. The estimation window (up to 120 sessions, at least 30) ends 5 sessions before the event; beta is shrunk towards one. With fewer than 30 observations alpha is 0 and beta is 1.'],
      ['День 0 — первая сессия, закрывшаяся после публикации. |z| меньше 1 — обычный шум, от 1 до 1,96 — заметное, от 1,96 — значимое.', 'Day 0 is the first session closing after publication. |z| below 1 is noise, 1 to 1.96 notable, 1.96 and above significant.'],
    ],
    formulas: [
      [['Рыночная модель и поправка Блюма', 'Market model and Blume adjustment'], 'r_t = \\alpha + \\beta m_t + \\epsilon_t, \\quad \\beta = 0.67 \\beta_{OLS} + 0.33'],
      [['Аномальная доходность и накопленная за 2 дня', 'Abnormal return and two-day cumulative'], 'AR_t = r_t - (\\alpha + \\beta m_t), \\quad CAR = AR_0 + AR_1'],
      [['z-оценка с учётом ошибки оценки', 'z score with estimation error'], 'z = \\frac{CAR}{\\sigma \\sqrt{k (1 + k/n)}}'],
    ],
    limits: [
      ['У доходностей толстые хвосты: порог 1,96 даёт чуть больше 5% ложных срабатываний.', 'Returns have fat tails: the 1.96 threshold raises slightly more than 5% false alarms.'],
      ['Совпадение по времени не доказывает причинность.', 'Coincidence in time does not prove causation.'],
    ],
    code: ['api/_dossier/quant.js', 'api/_dossier/events.js'],
    used: [EVENTS_TAB, OVERVIEW],
    related: ['fdr', 'significance', 'consequences'],
  },
  {
    id: 'reputation',
    title: ['Репутация', 'Reputation'],
    question: ['Какой тон у новостей о компании?', 'What is the tone of the company news?'],
    explain: [
      ['Взвешенный тон заголовков за 90 дней по шкале 0–100, 50 — нейтрально. Вес зависит от типа события, источника, числа подтверждающих изданий и возраста. Тройка в знаменателе — нейтральное априорное свидетельство.', 'Weighted headline tone over 90 days on a 0–100 scale, 50 is neutral. The weight depends on event type, source, number of corroborating outlets and age. The 3 in the denominator is neutral prior evidence.'],
      ['Полураспады: руководство 30 дней, скандал 45, регулирование 30, отчётность и сделки 21, политика 14, продукт 10, прочее 7. Источник: SEC 1,0, крупная редакция 0,9, прочие 0,65.', 'Half-lives: leadership 30 days, scandal 45, regulation 30, earnings and deals 21, politics 14, product 10, other 7. Source weight: SEC 1.0, major newsroom 0.9, other 0.65.'],
    ],
    formulas: [
      [['Вес свидетельства', 'Evidence weight'], 'w = T \\cdot Q \\cdot K \\cdot 2^{-a/H}, \\quad K = \\min(2, 1 + 0.35 \\ln k)'],
      [['Оценка', 'Score'], 'R = 50 + 50 \\frac{\\sum w s}{\\sum w + 3}'],
      [['Погрешность через эффективный размер выборки', 'Error via effective sample size'], 'n_{eff} = \\frac{(\\sum w)^2}{\\sum w^2}, \\quad \\pm = 50 \\cdot 1.96 \\sqrt{\\frac{v}{n_{eff} + 3}}'],
    ],
    limits: [
      ['Веса типов и источников — объяснимые эвристики, не проверены.', 'Type and source weights are explainable heuristics, not validated.'],
      ['Тон не предсказывает следующие 1, 5 и 20 сессий (см. бэктест новостей).', 'Tone does not predict the next 1, 5 or 20 sessions (see the news backtest).'],
    ],
    code: ['api/_dossier/quant.js'],
    used: [dossier('overview', ['Досье: обзор компании', 'Dossier: company overview']), METRICS_TAB],
    related: ['attention', 'event-study'],
  },
  {
    id: 'attention',
    title: ['Индекс внимания', 'Attention index'],
    question: ['Насколько сегодняшний день не похож на обычный?', 'How unlike a normal day is today?'],
    explain: [
      ['Складываются четыре признака: аномальная доходность, всплеск новостей (преобразование Анскомба), объём к медиане и режим волатильности (σ20 / σ120). Веса: цена, объём, волатильность по 0,7/3, новости 0,3; каждый признак обрезается на 4.', 'Four signals are combined: abnormal return, news burst (Anscombe transform), volume against its median and volatility regime (σ20 / σ120). Weights: price, volume and volatility 0.7/3 each, news 0.3; each is capped at 4.'],
      ['Ниже 35 — обычный день, 35–64 — повышенное внимание, от 65 — необычный. Если доступный вес меньше 0,5, индекса нет.', 'Below 35 is normal, 35–64 raised attention, 65 and above unusual. If the available weight is below 0.5 there is no index.'],
    ],
    formulas: [
      [['Всплеск новостей', 'News burst'], 'z = 2 (\\sqrt{n + 3/8} - \\sqrt{\\lambda + 3/8})'],
      [['Объём и волатильность', 'Volume and volatility'], 'x_v = \\max(0, \\ln_2 V), \\quad x_\\sigma = \\max(0, \\frac{\\ln \\rho}{\\ln 1.5})'],
      [['Индекс', 'Index'], 'E = \\frac{\\sum w_i \\min(4, x_i)}{\\sum w_i}, \\quad A = 100 (1 - e^{-E})'],
    ],
    limits: [
      ['Мера необычности, а не прогноз: связь с размером следующих движений слабая (ρ около 0,1), с направлением её нет.', 'A measure of unusualness, not a forecast: link with the size of later moves is weak (ρ about 0.1), none with direction.'],
      ['Вес новостей 0,3 не проверен.', 'The news weight 0.3 is not validated.'],
    ],
    code: ['api/_dossier/quant.js'],
    used: [dossier('overview', ['Досье: сводка сигналов', 'Dossier: signal summary']), OVERVIEW],
    related: ['reputation', 'volatility', 'metrics'],
  },
  {
    id: 'significance',
    title: ['Значимость события', 'Event significance'],
    question: ['Насколько заметной может оказаться реакция на событие?', 'How noticeable may the reaction to an event be?'],
    explain: [
      ['Начальные шансы зависят от типа события; к логарифму шансов добавляются надёжность источника, число подтверждений, тон, положение компании в заголовке и новизна. Затем поправка по похожим случаям, реакция цены и объём. Текущая значимость затухает со временем.', 'Prior odds depend on the event type; source credibility, corroboration, tone, company salience and novelty are added to the log odds. Then come an analogue calibration, price reaction and volume. Current significance decays with age.'],
    ],
    formulas: [
      [['Оценка при публикации', 'Score at publication'], '\\eta = logit(p_0) + 0.8 \\ln \\frac{c}{0.5} + 0.7 \\ln n_{eff} + 1.2 (|s| - 0.3) + (q - 0.6) + 0.8 (u - 0.7)'],
      [['Эффективное число изданий', 'Effective number of outlets'], 'n_{eff} = \\frac{k}{1 + 0.3 (k - 1)}'],
      [['Затухание', 'Decay'], 'S_{now} = S \\cdot \\exp(-\\frac{a^2}{2 \\tau^2})'],
    ],
    limits: [
      ['Априорные вероятности и веса заданы вручную.', 'Priors and weights are set by hand.'],
      ['Значимость описывает величину реакции, а не направление.', 'Significance describes size of reaction, not direction.'],
    ],
    code: ['api/_dossier/math/significance.js'],
    used: [EVENTS_TAB],
    related: ['event-study', 'forecast'],
  },
  {
    id: 'volatility',
    title: ['GARCH и волатильность', 'GARCH and volatility'],
    question: ['Насколько бурным будет ближайшее время?', 'How turbulent is the near term?'],
    explain: [
      ['GARCH(1,1) с инновациями Стьюдента: сегодняшняя дисперсия зависит от вчерашнего шока и вчерашней дисперсии. Таргетирование дисперсии оставляет три свободных параметра; оптимизатор Нелдера–Мида, 7 стартов. Нужно не меньше 100 наблюдений. Рядом EWMA с λ = 0,94.', 'GARCH(1,1) with Student innovations: today’s variance depends on yesterday’s shock and variance. Variance targeting leaves three free parameters; Nelder–Mead with 7 starts. At least 100 observations. EWMA with λ = 0.94 alongside.'],
    ],
    formulas: [
      [['GARCH(1,1)', 'GARCH(1,1)'], '\\sigma_t^2 = \\omega + \\alpha \\epsilon_{t-1}^2 + \\beta \\sigma_{t-1}^2, \\quad \\omega = S^2 (1 - \\alpha - \\beta)'],
      [['EWMA', 'EWMA'], '\\sigma_{t+1}^2 = \\lambda \\sigma_t^2 + (1 - \\lambda) r_t^2'],
      [['Полураспад и прогноз', 'Half-life and forecast'], '\\tau = \\frac{\\ln 0.5}{\\ln(\\alpha + \\beta)}, \\quad E \\sigma_{n+h}^2 = S^2 + (\\alpha + \\beta)^{h-1} (\\sigma_{n+1}^2 - S^2)'],
    ],
    limits: [
      ['Рост и падение влияют одинаково: эффекта рычага в этой модели нет.', 'Rises and falls act the same: no leverage effect in this model.'],
      ['Один неочищенный сплит раздувает долгосрочную дисперсию.', 'A single unadjusted split inflates long-run variance.'],
    ],
    code: ['api/_dossier/math/volatility.js'],
    used: [MODEL_TAB],
    related: ['var-es', 'forecast', 'hmm'],
  },
  {
    id: 'var-es',
    title: ['VaR и ожидаемые потери', 'VaR and expected shortfall'],
    question: ['Сколько можно потерять за один плохой день?', 'How much can one bad day cost?'],
    explain: [
      ['Три оценки на горизонте один день: историческая, параметрическая по Стьюденту (σ и ν из GARCH) и поправка Корниша–Фишера на асимметрию и эксцесс (только там, где разложение монотонно). Минимум 60 наблюдений. Рядом максимальная просадка и скачки Ли–Майкленда.', 'Three one-day estimates: historical, parametric Student (σ and ν from GARCH) and the Cornish–Fisher correction for skew and kurtosis (only where it is monotone). At least 60 observations. Maximum drawdown and Lee–Mykland jumps alongside.'],
    ],
    formulas: [
      [['VaR', 'VaR'], 'VaR = \\max(0, 1 - e^{q}), \\quad q = Q_r(1 - c)'],
      [['Ожидаемые потери в хвосте', 'Expected shortfall'], 'ES = \\frac{1}{|T|} \\sum_{t \\in T} \\max(0, 1 - e^{r_t}), \\quad T = \\{ t : r_t \\le q \\}'],
      [['Корниш–Фишер', 'Cornish–Fisher'], 'z_{cf} = z + \\frac{(z^2 - 1) S}{6} + \\frac{(z^3 - 3 z) K}{24} - \\frac{(2 z^3 - 5 z) S^2}{36}'],
      [['Максимальная просадка', 'Maximum drawdown'], 'MDD = \\max_{s \\le t} (1 - \\frac{C_t}{C_s})'],
    ],
    limits: [
      ['На реальных ценах исторический и параметрический VaR занижают риск; Корниш–Фишер ближе к уровню (см. бэктест цен).', 'On real prices historical and parametric VaR understate risk; Cornish–Fisher is closer (see the price backtest).'],
    ],
    code: ['api/_dossier/math/risk.js'],
    used: [MODEL_TAB, ATLAS],
    related: ['volatility', 'metrics'],
  },
  {
    id: 'forecast',
    title: ['Коридор прогноза', 'Forecast corridor'],
    question: ['В каком диапазоне может быть цена через 1, 5 и 20 сессий?', 'Within what range may the price be in 1, 5 and 20 sessions?'],
    explain: [
      ['Это оценка разброса, а не направления: коридор центрирован на нуле. Дисперсия — гетерогенная авторегрессия по долгому уровню, диапазонам баров, квартальной повторяемости и индексу рынка; распределение Стьюдента. Новости и отчётности расширяют коридор множителем k.', 'An estimate of spread, not direction: the corridor is centred on zero. Variance is a heterogeneous autoregression over the long level, bar ranges, quarterly repeats and the market index; the distribution is Student. News and earnings widen it by a factor k.'],
    ],
    formulas: [
      [['Дисперсия на горизонте', 'Horizon variance'], '\\sigma_h^2 = h \\sum_i w_{i,h} x_i'],
      [['Дневная дисперсия по диапазону', 'Daily range variance'], 'v_t = \\ln^2 \\frac{O_t}{C_{t-1}} + \\max(\\frac{1}{2} \\ln^2 \\frac{H_t}{L_t} - (2 \\ln 2 - 1) \\ln^2 \\frac{C_t}{O_t}, 0)'],
      [['Квантили', 'Quantiles'], 'q_p = k s_h \\sigma_h t_{\\nu}^{-1}(p)'],
    ],
    limits: [
      ['Выигрыш против простых баз мал; направление коридор не задаёт (оно оценивается отдельно и слабо).', 'The gain over simple baselines is small; the corridor gives no direction (a separate, weak estimate does).'],
    ],
    code: ['api/_dossier/math/volmodel.js', 'api/_dossier/math/forecast.js'],
    used: [['/forecast.html#/', ['Раздел «Прогноз»', 'Forecast section']], dossier('forecast', ['Досье: вкладка «Прогноз»', 'Dossier: Forecast tab']), FORECAST],
    related: ['volatility', 'significance', 'consequences'],
  },
  {
    id: 'kalman',
    title: ['Бета во времени (Калман)', 'Time-varying beta (Kalman)'],
    question: ['Как меняется связь акции с рынком?', 'How does the link to the market change?'],
    explain: [
      ['Бета следует случайному блужданию; дисперсии шумов q и r подбираются максимумом правдоподобия ошибок одного шага. Нужно не меньше 60 пар дней; при вырожденной оценке ответ «нет данных».', 'Beta follows a random walk; noise variances q and r maximise the one-step prediction likelihood. At least 60 day pairs; degenerate fits answer no data.'],
    ],
    formulas: [
      [['Наблюдение и состояние', 'Observation and state'], 'r_t = \\alpha + \\beta_t m_t + e_t, \\quad \\beta_t = \\beta_{t-1} + w_t'],
      [['Инновация и усиление', 'Innovation and gain'], 'F_t = m_t^2 P_{t|t-1} + r, \\quad K_t = \\frac{P_{t|t-1} m_t}{F_t}'],
      [['Обновление', 'Update'], '\\beta_{t|t} = \\beta_{t|t-1} + K_t v_t'],
    ],
    limits: [['Гауссовы ошибки; скачок беты размазывается; интервал не учитывает риск модели.', 'Gaussian errors; jumps in beta are smeared; the interval ignores model risk.']],
    code: ['api/_dossier/math/kalman.js'],
    used: [MODEL_TAB],
    related: ['event-study', 'hmm', 'changepoints'],
  },
  {
    id: 'hmm',
    title: ['Режимы рынка (HMM)', 'Market regimes (HMM)'],
    question: ['Спокойный сейчас режим или турбулентный?', 'Is the regime calm or turbulent?'],
    explain: [
      ['Скрытая марковская модель с двумя состояниями, обучение EM (Баум–Велч). Показывается фильтрованная вероятность турбулентности. Результат отвергается, если состояния почти не различаются, слишком коротки или не окупают штраф BIC. Минимум 100 наблюдений.', 'A two-state hidden Markov model fitted by EM (Baum–Welch). The filtered probability of turbulence is shown. The fit is rejected if states barely differ, are too short or do not pay the BIC penalty. At least 100 observations.'],
    ],
    formulas: [
      [['Переходы и наблюдения', 'Transitions and observations'], 'P(S_t = j | S_{t-1} = i) = A_{ij}, \\quad r_t \\sim N(\\mu_k, \\sigma_k^2)'],
      [['Ожидаемая длительность', 'Expected duration'], 'D_k = \\frac{1}{1 - A_{kk}}'],
    ],
    limits: [['Параметры подогнаны по всей истории; смену режима модель не предсказывает.', 'Parameters use the whole history; regime switches are not predicted.']],
    code: ['api/_dossier/math/hmm.js'],
    used: [MODEL_TAB],
    related: ['changepoints', 'volatility'],
  },
  {
    id: 'changepoints',
    title: ['Точки перелома', 'Change points'],
    question: ['Сменилось ли поведение цены недавно?', 'Has price behaviour changed recently?'],
    explain: [
      ['Байесовское онлайн-обнаружение Адамса–Маккея смены среднего или дисперсии. Априорная частота смены — раз в 60 сессий; сигнал — вероятность, что новый отрезок начался в последние 5 дней. Минимум 60 наблюдений.', 'Adams–MacKay Bayesian online detection of mean or variance shifts. Prior rate is one change per 60 sessions; the signal is the probability that a new segment began in the last 5 days. At least 60 observations.'],
    ],
    formulas: [
      [['Новая серия', 'New run'], 'P(r_t = 0 | x) \\sim \\sum_r P(r_{t-1} = r) \\pi(x_t | r) H'],
      [['Рост серии', 'Run growth'], 'P(r_t = r + 1 | x) \\sim P(r_{t-1} = r) \\pi(x_t | r) (1 - H), \\quad H = \\frac{1}{60}'],
    ],
    limits: [['Не отличает смену режима от разовой новости; список переломов может пересматриваться.', 'Cannot tell a regime change from a one-off headline; breaks may be revised.']],
    code: ['api/_dossier/math/changepoint.js'],
    used: [MODEL_TAB],
    related: ['hmm', 'kalman'],
  },
  {
    id: 'hawkes',
    title: ['Процесс Хокса', 'Hawkes process'],
    question: ['Порождают ли новости новые новости?', 'Do headlines breed more headlines?'],
    explain: [
      ['Интенсивность потока заголовков — фон плюс затухающий вклад прошлых событий. Окно 30 дней, минимум 20 событий. «Самовозбуждается» только если модель выигрывает по AIC с запасом 6 у ровного пуассона, тренда, суточно-недельного ритма и скачка уровня.', 'Headline intensity is a background plus decaying excitement from past events. 30-day window, at least 20 events. It is called self-exciting only if it beats flat Poisson, trend, daily-weekly rhythm and level step by an AIC margin of 6.'],
    ],
    formulas: [
      [['Интенсивность', 'Intensity'], '\\lambda(t) = \\mu + \\sum_{t_i < t} n \\beta e^{-\\beta (t - t_i)}'],
      [['Правдоподобие', 'Likelihood'], 'l = \\sum_i \\ln(\\mu + n \\beta A_i) - \\mu T - n \\sum_i (1 - e^{-\\beta (T - t_i)})'],
      [['Рекурсия', 'Recursion'], 'A_i = e^{-\\beta (t_i - t_{i-1})} (1 + A_{i-1})'],
    ],
    limits: [['На симуляции признаётся в 8% прогонов при ветвлении 0,5 и в 47% при 0,8: флаг консервативен.', 'In simulation it is flagged in 8% of runs at branching 0.5 and 47% at 0.8: the flag is conservative.']],
    code: ['api/_dossier/math/hawkes.js'],
    used: [MODEL_TAB],
    related: ['fdr', 'attention'],
  },
  {
    id: 'fdr',
    title: ['FDR и проверки значимости', 'FDR and significance tests'],
    question: ['Не случайна ли находка, если проверок много?', 'Is a finding just chance among many tests?'],
    explain: [
      ['Поправка Бенджамини–Хохберга на множественные проверки (уровень 0,1), ранговый тест Коррадо, бутстрэп накопленной доходности (2000 выборок) и объединение p-значений методом Фишера.', 'Benjamini–Hochberg multiple-testing correction (level 0.1), Corrado rank test, bootstrap of the cumulative return (2000 samples) and Fisher’s combination of p values.'],
    ],
    formulas: [
      [['Порог Бенджамини–Хохберга', 'Benjamini–Hochberg threshold'], 'p_{(i)} \\le \\frac{i}{m} q'],
      [['Тест Коррадо', 'Corrado test'], 'z = \\frac{\\sum (K - (T+1)/2)}{\\sqrt{L s^2 (T - L) / (T - 1)}}'],
      [['Метод Фишера', 'Fisher method'], 'X = -2 \\sum \\ln p_i \\sim \\chi_{2k}^2'],
    ],
    limits: [['Метод Фишера предполагает независимые p-значения.', 'Fisher’s method assumes independent p values.']],
    code: ['api/_dossier/math/inference.js'],
    used: [EVENTS_TAB, MODEL_TAB],
    related: ['event-study', 'hawkes'],
  },
  {
    id: 'metrics',
    title: ['Метрики доходности и риска', 'Return and risk metrics'],
    question: ['Как компания выглядит в цифрах за год?', 'How does the company look in numbers over a year?'],
    explain: [
      ['Только завершённые сессии, год — 252 сессии, безрисковая ставка 0, цены без дивидендов. Ниже минимума наблюдений — «нет данных». Доходности, просадки, коэффициенты, связь с рынком, распределение, волатильность по диапазону, тренд и новостной поток.', 'Closed sessions only, a year is 252 sessions, risk-free rate 0, prices without dividends. Below the minimum sample the answer is no data. Returns, drawdowns, ratios, market link, distribution, range volatility, trend and news flow.'],
    ],
    formulas: [
      [['Шарп и его ошибка (Lo, 2002)', 'Sharpe and its error (Lo, 2002)'], 'SR = \\frac{mean(R)}{sd(R)} \\sqrt{252}, \\quad SE = \\sqrt{\\frac{1 + SR^2 / 504}{n}} \\sqrt{252}'],
      [['Индекс Ulcer', 'Ulcer index'], 'D_t = \\frac{C_t}{\\max_{s \\le t} C_s} - 1, \\quad UI = \\sqrt{mean(D^2)}'],
      [['Паркинсон', 'Parkinson'], '\\sigma^2 = \\frac{1}{4 \\ln 2} mean(\\ln^2 \\frac{H}{L})'],
    ],
    limits: [['На одном годе ошибка Шарпа порядка 1: десятые доли — шум.', 'Over one year the Sharpe error is about 1: tenths are noise.']],
    code: ['api/_dossier/math/metrics.js', 'api/_dossier/math/market.js'],
    used: [METRICS_TAB, ['/dossier.html?view=screener', ['Скринер', 'Screener']]],
    related: ['var-es', 'networks'],
  },
  {
    id: 'networks',
    title: ['Сети связей', 'Correlation networks'],
    question: ['Кто с кем движется вместе?', 'What moves together?'],
    explain: [
      ['Корреляции доходностей переводятся в расстояние Мантеньи; строятся остовное дерево Краскала, кластеры средней связи, центральности (Брандес, гармоническая близость, PageRank с затуханием 0,85), кластерный коэффициент и сообщества Лувена. Отдельно граф совместных упоминаний в заголовках.', 'Return correlations become Mantegna distances; then a Kruskal spanning tree, average-linkage clusters, centralities (Brandes, harmonic closeness, PageRank with damping 0.85), clustering coefficient and Louvain communities. A headline co-mention graph is separate.'],
    ],
    formulas: [
      [['Расстояние Мантеньи', 'Mantegna distance'], 'd_{ij} = \\sqrt{2 (1 - \\rho_{ij})}'],
      [['PageRank', 'PageRank'], 'y_i = \\frac{1 - 0.85}{N} + 0.85 \\sum_j \\frac{w_{ij}}{s_j} y_j'],
      [['Модулярность', 'Modularity'], 'Q = \\frac{1}{2 m} \\sum_{ij} (w_{ij} - \\frac{k_i k_j}{2 m}) \\delta(c_i, c_j)'],
    ],
    limits: [['Корреляция и совместное упоминание не говорят о владении, поставках или причинности.', 'Correlation and co-mention say nothing about ownership, supply or causation.']],
    code: ['api/_dossier/math/network.js', 'api/_dossier/math/atlas.js', 'api/_dossier/math/comentions.js'],
    used: [ATLAS],
    related: ['metrics'],
  },
  {
    id: 'instability',
    title: ['Индекс нестабильности стран', 'Country instability index'],
    question: ['Насколько рынки и новости страны отклоняются от нормы в сторону риска?', 'How far do a country’s markets and news deviate towards risk?'],
    explain: [
      ['Семь компонентов: волатильность, просадка и шок акций, волатильность и ослабление валюты, объём и тон новостей. Робастные z, веса с поправкой на корреляции, среднее степени 2, стресс Махаланобиса, вклады Шепли, байесовское сжатие и 90% интервал. Это не вероятность кризиса.', 'Seven components: equity volatility, drawdown and shock, currency volatility and depreciation, news volume and tone. Robust z scores, correlation-aware weights, power mean of order 2, Mahalanobis stress, Shapley contributions, Bayesian shrinkage and a 90% interval. Not a crisis probability.'],
    ],
    formulas: [
      [['Робастная стандартизация', 'Robust standardisation'], 'z_t = \\frac{x_t - med(x)}{1.4826 \\cdot MAD}'],
      [['Среднее степени 2', 'Power mean'], 'M = \\sqrt{\\sum_i w_i s_i^2}'],
      [['Объединение со стрессом', 'Stress combination'], 'Q = 100 \\Lambda(logit \\frac{M}{100} + 0.25 \\frac{D}{\\sqrt{k}})'],
      [['Сжатие', 'Shrinkage'], 'I = 100 \\Lambda(\\mu + B (\\theta - \\mu))'],
    ],
    limits: [['Веса экспертные; предсказательная сила не проверялась; тон по английскому словарю.', 'Weights are expert choices; predictive power untested; tone uses an English dictionary.']],
    code: ['api/_dossier/math/instability.js', 'api/_dossier/instability-data.js'],
    used: [DASH, ['#/countries', ['Страницы стран', 'Country pages']]],
    related: ['geoscore'],
  },
  {
    id: 'geoscore',
    title: ['Геополитическая оценка', 'Geopolitical score'],
    question: ['Насколько напряжена точка на карте или событие?', 'How tense is a map point or event?'],
    explain: [
      ['Балл 0–100 из семи факторов: всплеск новостей, подтверждение источниками, тяжесть и тон, нестабильность страны, близость к конфликтам, проливы и ядерные объекты, реакция рынков. Пропущенный фактор не заменяется нулём; чем меньше данных, тем сильнее сжатие к среднему и шире интервал.', 'A 0–100 score from seven factors: news burst, corroboration, severity and tone, country instability, conflict proximity, chokepoints and nuclear sites, market reaction. A missing factor is not zeroed; less data means more shrinkage and a wider interval.'],
    ],
    formulas: [
      [['Свежесть и источники', 'Freshness and sources'], 'd = 2^{-a/36}, \\quad x_N = 1 - e^{-N/4}'],
      [['Объединение', 'Aggregation'], 'M = \\sqrt{\\sum w_i x_i^2}'],
      [['Балл', 'Score'], 'S = 100 (\\lambda M + (1 - \\lambda) \\mu), \\quad \\lambda = \\frac{\\tau^2}{\\tau^2 + v}'],
    ],
    limits: [['Веса и ширины ядер экспертные; сопоставление по ключевым словам ошибается.', 'Weights and kernel widths are expert choices; keyword matching errs.']],
    code: ['api/_dossier/math/geoscore.js', 'api/_dossier/geoscore-data.js'],
    used: [DASH, WORLD],
    related: ['instability'],
  },
  {
    id: 'consequences',
    title: ['Экономические последствия', 'Economic consequences'],
    question: ['Что из события следует и чего ждать в проверке?', 'What follows from an event and what to watch?'],
    explain: [
      ['Собирается по фиксированным правилам из уже посчитанных величин и таблицы типичных каналов, без языковых моделей. Направление «вверх» или «вниз» ставится только если коридор 80% на 5 сессий целиком по одну сторону нуля. Надёжность — достаточность данных.', 'Assembled by fixed rules from computed values and a table of typical channels, without language models. Up or down is set only when the 5-session 80% corridor lies wholly on one side of zero. Confidence means data sufficiency.'],
    ],
    formulas: [
      [['Отличимая реакция', 'Distinct reaction'], '|z| \\ge 1.96, \\quad q \\le 0.1'],
    ],
    limits: [['Каналы, горизонты и списки наблюдения — суждение, а не измерение.', 'Channels, horizons and watch lists are judgement, not measurement.']],
    code: ['api/_dossier/math/consequences.js'],
    used: [EVENTS_TAB, WORLD, OVERVIEW],
    related: ['event-study', 'forecast', 'significance', 'fdr'],
  },
];
