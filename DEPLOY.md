# Как выложить Money Bansho по публичной ссылке

Хостинг: **Vercel, тариф Hobby (бесплатный)**. Банковская карта и платные ключи не нужны.
Тариф разрешён только для некоммерческих проектов.

Конфигурация: `vercel.json`, `.vercelignore`, команда `npm run build:deploy`.

## Что работает без Redis на `*.vercel.app`

Проверено 28.11.2026 локальной имитацией (сборка `dist/`, правила из `vercel.json`,
обработчики `api/` в Node). **На самом Vercel не проверялось.**

| Часть | Результат |
|---|---|
| `/dossier` | работает |
| `/terminal` | работает, кроме счётчика источников из новостной ленты дашборда (401) |
| `/dashboard`: карта, слои из `/api/bootstrap?...&public=1` | открываются |
| `/dashboard`: новости, панели `/api/<домен>/v1/...` | **не работают** (401 / 403 / 503) |
| `/dashboard`: индекс нестабильности и оценка точек | **не загружаются**: без сессии перехватчик в `src/services/wm-session.ts` перестаёт отправлять запросы `/api/...` |

## Правки защиты, без которых дашборд не заработает (в коде их пока нет)

Нужны обе. Без первой `POST /api/wm-session` отвечает 403, без второй 503.
Вторая **отключает ограничение частоты запросов**, поэтому вносится только с согласия
владельца проекта и годится только для демо.

**1. Свой адрес в CORS**: `api/_cors.js` и `server/cors.ts`. Только точное совпадение,
без масок `*.vercel.app`. Функцию вызвать в `isAllowedOrigin` рядом с
`isOwnPreviewDeploymentOrigin`:

```js
function isOwnProductionOrigin(origin) {
  if (process.env.VERCEL_ENV !== 'production') return false;
  return [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL]
    .some((host) => Boolean(host) && origin === `https://${host}`);
}
```

**2. Демо без Redis**: `api/_rate-limit.js` (`checkRateLimit`) и
`server/_shared/rate-limit.ts` (`checkRateLimit`, `checkEndpointRateLimit`). В каждой из
трёх функций внутри ветки `if (!rl)`, до проверки `failClosed`, добавить
`if (demoWithoutRedis()) return null;`

```js
const demoWithoutRedis = () => process.env.DEMO_NO_REDIS === '1'
  && !process.env.UPSTASH_REDIS_REST_URL && !process.env.UPSTASH_REDIS_REST_TOKEN;
```

Если Redis настроен, лимиты продолжают работать. Не менять: проверку сессии и чужих
origin, проверку edge-proof, список доменов `rss-proxy`, `checkScopedRateLimit`
(защищает внешние геокодеры). На выключенное и включённое состояние нужны тесты.

## Что не заработает и после этих правок

Так же ведёт себя и `npm run dev` без ключей и Redis (кроме последней строки):

- климат и протесты отвечают 503; пожары, ACLED, макросигналы, перемещённые лица,
  военная обстановка отвечают пустыми данными;
- `/api/health`, `/api/product-catalog`, `/api/selfhost-key`: 404;
- уточнённые границы стран с `maps.worldmonitor.app` блокируются CORS;
- `/_vercel/insights/script.js`: 404, пока в проекте не включена аналитика;
- только в dev есть прокси `/api/opensky`, `/api/polymarket` и заглушка `/api/gpsjam`.

## Лимиты функций

- Функций 11 из 12. `api/domain-gateway.ts` обслуживает большинство разделов
  дашборда; `news`, `market`, `intelligence`, `displacement` лежат отдельно из-за
  лимита 1 МБ (gzip) на Edge-функцию. Запросы в общую функцию направляет правило в
  `vercel.json` со списком разделов (папка `[domain]` перехватывала новости и котировки).
  Не вошли `feedback`, `leads`, `batch`, `scenario`, `orbital`.
- Новый файл в `api/` без `_` в начале становится функцией: проверьте `.vercelignore`.
- Edge-функция должна начать ответ за 25 секунд. Холодное досье локально отвечало за
  12–24 секунды, то есть запас мал. Перед показом откройте нужные компании и проверьте их.
- Загружается около 83 МБ из 100 МБ, доступных CLI.

## Шаги (через терминал, без GitHub)

Все команды выполняются в папке проекта. Берётся то, что лежит в папке сейчас, коммит не нужен.
Поэтому запускайте деплой, когда остальные правки закончены.

**1. Войти в Vercel.** Аккаунт создаёте и подтверждаете вы сами (откроется браузер).

```powershell
npx vercel@latest login
```

**2. Создать проект.** Отвечайте: Set up and deploy — `Y`; scope — ваш личный;
link to existing — `N`; имя — `money-bansho`; каталог — `./`; изменить настройки — `N`.
**Эта команда уже загружает код на Vercel и делает первую сборку.** У нового проекта
первая сборка может сразу оказаться на публичном домене, поэтому запускайте её, только
когда готовы публиковать.

```powershell
npx vercel@latest
```

**3. Задать секрет сессии.** Сначала получите случайную строку:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Затем выполните команду и вставьте строку, когда Vercel спросит значение.
Никому её не отправляйте и не кладите в репозиторий.

```powershell
npx vercel@latest env add WM_SESSION_SECRET production
```

**4. Только если обе правки защиты внесены**, добавьте переменную со значением `1`.
Без правок она ничего не делает. В настройках проекта должен быть включён доступ к
системным переменным (Environment Variables → Automatically expose System Environment
Variables).

```powershell
npx vercel@latest env add DEMO_NO_REDIS production
```

**5. Опубликовать.** После этой команды сайт доступен всем, у кого есть ссылка.

```powershell
npx vercel@latest --prod
```

## Какую ссылку отдавать жюри

Отдавайте **постоянный домен проекта** (вида `money-bansho.vercel.app`; точное имя видно
на странице проекта в разделе Domains). Длинные адреса отдельных сборок по умолчанию
требуют входа в Vercel. После правки CORS дашборд принимает только этот домен и адрес
текущей сборки.

## Проверка (в окне инкогнито)

- `https://ВАШ-ДОМЕН/dashboard`, `/dossier`, `/terminal`.
- На страницах не должно быть окна входа Vercel. Если оно есть:
  Project → Settings → Deployment Protection.
- F12 → Network: `/api/dossier` отвечает 200; после правок защиты
  `POST /api/wm-session` отвечает 200.

Повторный деплой после любых правок — снова шаг 5.

## Лицензия AGPL-3.0

Проект основан на World Monitor. Раз сайт доступен по сети, пользователи должны иметь
возможность получить исходный код вашей версии. Выложите репозиторий публично и дайте
на него ссылку на сайте или в README, сохранив лицензию и указание на оригинал.

## Если что-то пошло не так

| Сообщение | Что делать |
|---|---|
| `No more than 12 Serverless Functions` | В `api/` появился новый файл. Проверьте список в `.vercelignore`. |
| Ошибка сборки `Could not resolve ...` | Сборке нужна папка, исключённая в `.vercelignore`. Удалите соответствующую строку. |
| Edge-функция превышает 1 МБ | Вынести тяжёлый раздел из `api/domain-gateway.ts` или убрать лишний. |
| `Session service not configured` | Не задан `WM_SESSION_SECRET`; задайте и повторите шаг 5. |
| `JavaScript heap out of memory` | Увеличьте `--max-old-space-size` в `build:deploy` (`package.json`). |

Лимиты Hobby в месяц: 100 ГБ трафика, 1 млн вызовов функций; до 100 деплоев в сутки
([документация Vercel](https://vercel.com/docs/plans/hobby)).
